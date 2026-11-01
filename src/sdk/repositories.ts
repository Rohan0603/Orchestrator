import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Attempt, Run, Task, EventCorrelation } from "../shared/domain";
import { assertRunTransition } from "../shared/domain";
import { appendDurableEvent } from "../persistence/events";
import { MessageDeliveryRepository, DeliveryFailure } from "../persistence/message-delivery-repository";
import { AGENT_MESSAGE_SCHEMA_VERSION } from "../shared/agent-message";
import { PersistenceError } from "../persistence/database";
import { TaskRepository } from "../persistence/task-repository";
import { PolicyRepository } from "../persistence/policy-repository";
import { evaluatePolicy, type PolicyAction, type PolicyDecisionRecord } from "../policy/policy";
import { createMcpClient, executePlugin, type McpTool, type McpToolResult } from "./capability-runtime";
import type {
  CreateProjectInput,
  InstallMcpServerInput,
  InstallSkillInput,
  InstallPluginInput,
  McpServerRecord,
  Project,
  RegisterWorkerInput,
  RunUsage,
  SkillRecord,
  TaskAssignment,
  TaskDependencyInfo,
  TaskRunHistoryInfo,
  TaskRevisionInfo,
  WorkerCapability,
  WorkerLease,
  WorkerMessage,
  WorkerMessageInput,
  WorkerRegistration,
  WorkerReportInput,
  UpdateTaskContentInput
} from "./contracts";
import { RunRepository } from "../persistence/run-repository";

function json<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function requireText(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function isProhibitedOperation(value: string): boolean {
  return /(?:git[._-]?push[._-]?force|force[._ -]?push|protected[._ -]?branch[._ -]?(?:bypass|override)|branch[._-]?protection[._-]?(?:disable|bypass)|auto[._ -]?merge)/i.test(value);
}

export class SdkRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly capacity: { readonly maxActiveRuns: number; readonly maxActiveRunsPerWorker: number } = {maxActiveRuns: 1, maxActiveRunsPerWorker: 1}
  ) {
    if (!Number.isSafeInteger(capacity.maxActiveRuns) || capacity.maxActiveRuns < 1 || capacity.maxActiveRuns > 100 ||
        !Number.isSafeInteger(capacity.maxActiveRunsPerWorker) || capacity.maxActiveRunsPerWorker < 1 || capacity.maxActiveRunsPerWorker > capacity.maxActiveRuns) {
      throw new Error("Invalid SDK active-run capacity");
    }
  }

  public createProject(input: CreateProjectInput): Project {
    const project: Project = {
      id: input.id?.trim() || randomUUID(),
      name: requireText(input.name, "Project name"),
      description: input.description?.trim() ?? "",
      repositoryPath: input.repositoryPath?.trim() || null,
      defaultBranch: input.defaultBranch?.trim() || null,
      createdAt: new Date().toISOString()
    };
    try {
      this.database.prepare(
        `INSERT INTO projects (id, name, description, repository_path, default_branch, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(project.id, project.name, project.description, project.repositoryPath, project.defaultBranch, project.createdAt);
      this.audit("project.created", project, { idempotencyKey: `project.created:${project.id}` });
      return project;
    } catch (error) {
      throw new PersistenceError("Project creation failed", { cause: error });
    }
  }

  public getProject(projectId: string): Project | null {
    const row = this.database.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as Record<string, unknown> | undefined;
    return row ? {id: String(row.id), name: String(row.name), description: String(row.description), repositoryPath: row.repository_path ? String(row.repository_path) : null,
      defaultBranch: row.default_branch ? String(row.default_branch) : null, createdAt: String(row.created_at)} : null;
  }

  public listProjects(): readonly Project[] {
    return (this.database.prepare("SELECT id FROM projects ORDER BY created_at,id").all() as Array<{id: string}>).map((row) => this.getProject(row.id)!).filter(Boolean);
  }

  public createTask(input: import("../shared/ipc").CreateTaskInput): Task {
    return new TaskRepository(this.database).create(input);
  }

  public updateTask(taskId: string, input: UpdateTaskContentInput): Task {
    return new TaskRepository(this.database).updateContent(taskId, input);
  }

  public getTask(taskId: string): Task | null {
    return new TaskRepository(this.database).get(taskId);
  }

  public listTasks(): readonly Task[] {
    return new TaskRepository(this.database).list();
  }

  public listTaskRuns(taskId: string): readonly TaskRunHistoryInfo[] {
    return new RunRepository(this.database).listForTask(taskId);
  }

  public listWorkerLeases(taskId?: string): readonly WorkerLease[] {
    const rows = taskId
      ? this.database.prepare("SELECT lease_token FROM worker_leases WHERE task_id=? ORDER BY created_at,id").all(taskId)
      : this.database.prepare("SELECT lease_token FROM worker_leases ORDER BY created_at,id").all();
    return (rows as Array<{lease_token: string}>).map((row) => this.getActiveLease(row.lease_token));
  }

  public listTaskRevisions(taskId: string): readonly TaskRevisionInfo[] {
    return new TaskRepository(this.database).revisions(taskId);
  }

  public addTaskDependency(taskId: string, dependsOnTaskId: string): TaskDependencyInfo {
    return new TaskRepository(this.database).addDependency(taskId, dependsOnTaskId);
  }

  public listTaskDependencies(taskId: string): readonly TaskDependencyInfo[] {
    return new TaskRepository(this.database).dependencies(taskId);
  }

  public registerWorker(input: RegisterWorkerInput): WorkerRegistration {
    const worker: WorkerRegistration = {
      id: input.id?.trim() || randomUUID(),
      name: requireText(input.name, "Worker name"),
      kind: input.kind?.trim() || "sdk-worker",
      capabilities: [...(input.capabilities ?? [])],
      status: "registered",
      lastSeenAt: null,
      createdAt: new Date().toISOString()
    };
    this.database.prepare(
      `INSERT INTO workers (id, name, kind, capabilities_json, status, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(worker.id, worker.name, worker.kind, JSON.stringify(worker.capabilities), worker.status, worker.lastSeenAt, worker.createdAt);
    this.audit("worker.registered", worker, { idempotencyKey: `worker.registered:${worker.id}` });
    return worker;
  }

  public installSkill(input: InstallSkillInput): SkillRecord {
    const instructions = requireText(input.instructions, "Skill instructions");
    const skill: SkillRecord = {
      id: input.id?.trim() || randomUUID(),
      name: requireText(input.name, "Skill name"),
      version: requireText(input.version, "Skill version"),
      sourcePath: requireText(input.sourcePath, "Skill source path"),
      description: input.description?.trim() ?? "",
      instructions,
      contentHash: createHash("sha256").update(instructions).digest("hex"),
      enabled: input.enabled ?? true,
      createdAt: new Date().toISOString()
    };
    this.database.prepare(
      `INSERT INTO skills (id, name, version, source_path, description, instructions, content_hash, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(skill.id, skill.name, skill.version, skill.sourcePath, skill.description, skill.instructions, skill.contentHash, skill.enabled ? 1 : 0, skill.createdAt);
    this.audit("skill.installed", { ...skill, instructions: undefined }, { idempotencyKey: `skill.installed:${skill.id}` });
    return skill;
  }

  public installMcpServer(input: InstallMcpServerInput): McpServerRecord {
    const server: McpServerRecord = {
      id: input.id?.trim() || randomUUID(),
      name: requireText(input.name, "MCP server name"),
      transport: input.transport,
      command: input.command?.trim() || null,
      arguments: [...(input.arguments ?? [])],
      url: input.url?.trim() || null,
      environment: { ...(input.environment ?? {}) },
      description: input.description?.trim() ?? "",
      enabled: input.enabled ?? true,
      createdAt: new Date().toISOString()
    };
    if (server.transport === "stdio" && !server.command) throw new Error("stdio MCP server requires a command");
    if (server.transport === "http" && !server.url) throw new Error("http MCP server requires a URL");
    this.database.prepare(
      `INSERT INTO mcp_servers
       (id, name, transport, command, arguments_json, url, environment_json, description, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(server.id, server.name, server.transport, server.command, JSON.stringify(server.arguments), server.url, JSON.stringify(server.environment), server.description, server.enabled ? 1 : 0, server.createdAt);
    this.audit("mcp_server.installed", { ...server, environment: undefined }, { idempotencyKey: `mcp_server.installed:${server.id}` });
    return server;
  }

  public installPlugin(input: InstallPluginInput) {
    const plugin = {
      id: input.id?.trim() || randomUUID(),
      name: requireText(input.name, "Plugin name"),
      version: requireText(input.version, "Plugin version"),
      entrypoint: requireText(input.entrypoint, "Plugin entrypoint"),
      capabilities: [...(input.capabilities ?? [])],
      enabled: input.enabled ?? true,
      createdAt: new Date().toISOString()
    };
    this.database.prepare(
      `INSERT INTO plugins (id, name, version, entrypoint, capabilities_json, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(plugin.id, plugin.name, plugin.version, plugin.entrypoint, JSON.stringify(plugin.capabilities), plugin.enabled ? 1 : 0, plugin.createdAt);
    this.audit("plugin.installed", plugin, { idempotencyKey: `plugin.installed:${plugin.id}` });
    return plugin;
  }

  public claimTask(workerId: string, leaseDurationMs = 60_000, approvalId?: string): TaskAssignment | null {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) throw new Error("Lease duration is invalid");
    try {
      const result = this.database.transaction(() => {
        this.reconcileExpiredLeases(now.toISOString());
        const worker = this.database.prepare("SELECT * FROM workers WHERE id = ?").get(workerId) as {
          id: string; capabilities_json: string; status: WorkerRegistration["status"]; kind: string
        } | undefined;
        if (!worker) throw new Error("Worker not found");
        if (worker.status === "suspended") throw new Error("Worker is suspended");
        if (!this.hasClaimCapacity(workerId, now.toISOString())) return null;
        const capabilities = json<WorkerCapability[]>(worker.capabilities_json, []);
        const rows = this.database.prepare(
          `SELECT tasks.* FROM tasks
           LEFT JOIN worker_leases ON worker_leases.task_id = tasks.id AND worker_leases.state = 'active'
           WHERE tasks.status IN ('intake', 'planned')
             AND worker_leases.id IS NULL
             AND NOT EXISTS (SELECT 1 FROM runs prior WHERE prior.task_id=tasks.id AND prior.state NOT IN ('blocked','awaiting_approval'))
             AND NOT EXISTS (SELECT 1 FROM message_deliveries pending WHERE pending.task_id=tasks.id AND pending.status<>'acknowledged')
           ORDER BY tasks.created_at, tasks.id`
        ).all() as Array<Record<string, unknown>>;
        const row = rows.find((candidate) => {
          const required = [
            ...json<string[]>(String(candidate.skill_ids ?? "[]"), []),
            ...json<string[]>(String(candidate.mcp_server_ids ?? "[]"), []),
            ...json<string[]>(String(candidate.plugin_ids ?? "[]"), [])
          ];
          return required.every((key) => capabilities.some((capability) => capability.key === key)) &&
            this.taskCapabilitiesEnabled(candidate);
        });
        if (!row) return null;
        const task = this.taskFromRow(row);
        const pendingRun = this.database.prepare("SELECT * FROM runs WHERE task_id=? AND state='awaiting_approval' ORDER BY created_at DESC LIMIT 1").get(task.id) as Record<string, unknown> | undefined;
        const taskRun = pendingRun
          ? this.pendingRun(task, pendingRun)
          : this.createRun(task, "orchestrator-worker-v1");
        const action = this.policyAction({
          operation: "worker.claim",
          target: "orchestrator-worker-v1",
          args: [workerId, task.id],
          payload: { runId: taskRun.run.id, taskId: task.id, workerId, taskRevision: task.createdAt },
          riskTier: task.riskTier,
          prohibited: worker.kind !== "sdk-worker",
          capabilityVerified: worker.kind === "sdk-worker" && this.taskCapabilitiesEnabled(row) && [
            ...task.skillIds, ...task.mcpServerIds, ...task.pluginIds
          ].every((key) => capabilities.some((capability) => capability.key === key)),
          evidenceComplete: task.acceptanceCriteria.length > 0,
          prerequisitesResolved: this.taskPrerequisitesResolved(task)
        });
        const policy = evaluatePolicy(action);
        new PolicyRepository(this.database).recordDecision(policy);
        if (policy.decision === "approval_required") {
          if (!pendingRun) this.transitionRun(taskRun.run, "awaiting_approval", task);
          if (!approvalId) return { policyError: `Approval required for task claim (run ${taskRun.run.id})` } as const;
          new PolicyRepository(this.database).consumeApproval(approvalId, action, policy.policyVersion, taskRun.run.id);
        } else if (policy.decision !== "allowed") {
          if (taskRun.run.state !== "blocked") this.transitionRun(taskRun.run, "blocked", task);
          this.database.prepare("UPDATE tasks SET status='blocked' WHERE id=?").run(task.id);
          return { policyError: `Task claim blocked by policy: ${policy.reasonCode}` } as const;
        } else if (approvalId) {
          throw new Error("Approval supplied for an action that does not require approval");
        }
        const readyRun = taskRun.run.state === "created"
          ? this.transitionRun(taskRun.run, "ready", task)
          : taskRun.run.state === "awaiting_approval"
            ? this.transitionRun(taskRun.run, "ready", task)
            : taskRun.run;
        const runningRun = this.transitionRun(readyRun, "running", task);
        const lease: WorkerLease = {
          id: randomUUID(),
          runId: runningRun.id,
          attemptId: taskRun.attempt.id,
          taskId: task.id,
          workerId,
          leaseToken: randomUUID(),
          state: "active",
          expiresAt,
          lastHeartbeatAt: now.toISOString(),
          createdAt: now.toISOString()
        };
        this.database.prepare(
          `INSERT INTO worker_leases
           (id, run_id, attempt_id, task_id, worker_id, lease_token, state, expires_at, last_heartbeat_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(lease.id, lease.runId, lease.attemptId, lease.taskId, lease.workerId, lease.leaseToken, lease.state, lease.expiresAt, lease.lastHeartbeatAt, lease.createdAt);
        this.database.prepare("UPDATE workers SET status = 'online', last_seen_at = ? WHERE id = ?").run(now.toISOString(), workerId);
        this.database.prepare("UPDATE tasks SET assigned_worker_id = ?, status = 'planned' WHERE id = ?").run(workerId, task.id);
        const handoff = this.buildHandoff(task, lease);
        this.appendMessage(lease, workerId, "orchestrator_to_worker", "handoff", 1, handoff, `handoff:${lease.runId}`);
        this.audit("task.claimed", { taskId: task.id, runId: lease.runId, workerId, leaseId: lease.id }, {
          taskId: task.id, runId: lease.runId, attemptId: lease.attemptId, idempotencyKey: `task.claimed:${lease.runId}`
        });
        return { task: { ...task, assignedWorkerId: workerId, status: "planned" as const }, run: runningRun, attempt: taskRun.attempt, lease, handoff };
      }).immediate();
      if (result && "policyError" in result) throw new Error(result.policyError);
      return result;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(`Task claim failed${error instanceof Error ? `: ${error.message}` : ""}`, { cause: error });
    }
  }

  public retryRecoveredTask(taskId: string, workerId: string, approvalId?: string): TaskAssignment | null {
    try {
      this.database.transaction(() => {
        const taskRow = this.database.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as Record<string, unknown> | undefined;
        if (!taskRow) throw new Error("Task not found");
        const task = this.taskFromRow(taskRow);
        const recovered = this.database.prepare(`SELECT r.* FROM runs r JOIN recovery rc ON rc.run_id=r.id
          WHERE r.task_id=? AND r.state='recovery_required' AND r.recovery_state='reconciled' AND rc.state='reconciled'
          ORDER BY r.created_at DESC LIMIT 1`).get(taskId) as Record<string, unknown> | undefined;
        if (!recovered) throw new Error("Task has no reconciled recovery outcome");
        const run: Run = {
          id: String(recovered.id), taskId, state: "recovery_required", routeId: recovered.route_id ? String(recovered.route_id) : null,
          recoveryState: "reconciled", createdAt: String(recovered.created_at)
        };
        this.transitionRun(run, "blocked", task);
        this.database.prepare("UPDATE tasks SET status='planned',assigned_worker_id=NULL WHERE id=? AND status='blocked'").run(taskId);
        this.audit("task.retry_authorized", {taskId, previousRunId: run.id, workerId, recoveryState: "reconciled"}, {
          taskId, runId: run.id, idempotencyKey: `task.retry_authorized:${run.id}`
        });
      }).immediate();
      return this.claimTask(workerId, 60_000, approvalId);
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(`Recovered task retry failed${error instanceof Error ? `: ${error.message}` : ""}`, {cause: error});
    }
  }

  public heartbeat(leaseToken: string, leaseDurationMs = 60_000): WorkerLease {
    const lease = this.getActiveLease(leaseToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    const result = this.database.prepare(
      "UPDATE worker_leases SET expires_at = ?, last_heartbeat_at = ? WHERE lease_token = ? AND state = 'active' AND expires_at > ?"
    ).run(expiresAt, now.toISOString(), leaseToken, now.toISOString());
    if (result.changes !== 1) throw new Error("Worker lease is expired or inactive");
    this.database.prepare("UPDATE workers SET status = 'online', last_seen_at = ? WHERE id = ?").run(now.toISOString(), lease.workerId);
    const updated = this.getActiveLease(leaseToken);
    this.appendMessage(updated, lease.workerId, "worker_to_orchestrator", "heartbeat", this.nextWorkerSequence(updated.runId), { expiresAt }, `heartbeat:${leaseToken}:${now.toISOString()}`);
    return updated;
  }

  public sendWorkerMessage(workerId: string, input: WorkerMessageInput): WorkerMessage {
    const lease = this.getActiveLease(input.leaseToken);
    if (lease.workerId !== workerId) throw new Error("Worker does not own lease");
    if (lease.expiresAt <= new Date().toISOString()) throw new Error("Worker lease is expired");
    if (input.idempotencyKey) {
      const existing = this.database.prepare("SELECT * FROM worker_messages WHERE idempotency_key = ?").get(input.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) {
        if (String(existing.run_id) !== lease.runId || String(existing.payload_json) !== JSON.stringify(input.payload)) {
          throw new Error("Worker message idempotency key reused with different payload");
        }
        return {
          id: String(existing.id), runId: String(existing.run_id), attemptId: String(existing.attempt_id), workerId: existing.worker_id ? String(existing.worker_id) : null,
          direction: String(existing.direction) as WorkerMessage["direction"], kind: String(existing.kind) as WorkerMessage["kind"], sequence: Number(existing.sequence),
          payload: JSON.parse(String(existing.payload_json)) as unknown, idempotencyKey: String(existing.idempotency_key), createdAt: String(existing.created_at)
        };
      }
    }
    const expectedSequence = this.nextWorkerSequence(lease.runId);
    if (input.sequence !== expectedSequence) throw new Error(`Worker message sequence must be ${expectedSequence}`);
    return this.appendMessage(lease, workerId, "worker_to_orchestrator", input.kind, input.sequence, input.payload, input.idempotencyKey ?? null);
  }

  public reportTask(workerId: string, input: WorkerReportInput): void {
    this.database.transaction(() => this.reportTaskInTransaction(workerId, input)).immediate();
  }

  private reportTaskInTransaction(workerId: string, input: WorkerReportInput): void {
    if (
      typeof input.source.adapterId !== "string" || input.source.adapterId.trim().length === 0 || input.source.adapterId.length > 128 ||
      typeof input.source.sessionId !== "string" || input.source.sessionId.trim().length === 0 || input.source.sessionId.length > 256
    ) throw new DeliveryFailure("permanent", "invalid_worker_source_reference");
    const reportKey = `report:${input.leaseToken}:${input.sequence}`;
    const existing = this.database.prepare("SELECT payload_json,worker_id,kind,direction FROM worker_messages WHERE idempotency_key = ?").get(reportKey) as { payload_json: string; worker_id: string; kind: string; direction: string } | undefined;
    if (existing) {
      if (existing.kind !== "report" || existing.direction !== "worker_to_orchestrator" || existing.worker_id !== workerId || existing.payload_json !== JSON.stringify(input)) throw new Error("Worker report idempotency key reused with different payload or owner");
      // A worker can pre-persist a report message. Only the orchestrator's atomic
      // completion audit proves the lifecycle transition committed with it.
      if (this.database.prepare("SELECT 1 FROM audit_events WHERE idempotency_key=?").get(`worker.reported:${input.leaseToken}:${input.sequence}`)) return;
    }
    const message = this.sendWorkerMessage(workerId, {
      leaseToken: input.leaseToken,
      kind: "report",
      sequence: input.sequence,
      payload: input,
      idempotencyKey: reportKey
    });
    const lease = this.getActiveLease(input.leaseToken);
    const run = this.database.prepare("SELECT state FROM runs WHERE id = ?").get(lease.runId) as { state: Run["state"] } | undefined;
    if (lease.state !== "active" || !this.database.prepare(`SELECT 1 FROM attempts a JOIN runs r ON r.id=a.run_id
      WHERE a.id=? AND r.id=? AND r.task_id=? AND a.outcome='pending' AND r.state='running' AND r.recovery_state='none'
      AND NOT EXISTS (SELECT 1 FROM attempts newer WHERE newer.run_id=r.id AND newer.rowid>a.rowid)
      AND NOT EXISTS (SELECT 1 FROM runs newer WHERE newer.task_id=r.task_id AND newer.rowid>r.rowid)`
    ).get(lease.attemptId, lease.runId, lease.taskId)) throw new DeliveryFailure("conflict", "stale_authoritative_attempt");
    if (!run) throw new Error("Run not found");
    const nextState: Run["state"] = input.outcome === "succeeded" ? "verification" : input.outcome === "failed" ? "rejected" : "inconclusive";
    assertRunTransition(run.state, nextState);
    const attemptOutcome = input.outcome === "succeeded" ? "succeeded" : input.outcome === "failed" ? "failed" : input.outcome === "cancelled" ? "cancelled" : "inconclusive";
    this.database.transaction(() => {
      if (this.database.prepare("UPDATE attempts SET outcome = ?, worker_report = ? WHERE id = ? AND outcome = 'pending'").run(attemptOutcome, input.summary, lease.attemptId).changes !== 1) throw new DeliveryFailure("conflict", "stale_authoritative_attempt");
      if (this.database.prepare("UPDATE runs SET state = ?, recovery_state = ? WHERE id = ? AND state='running'").run(nextState, nextState === "inconclusive" ? "uncertain" : "none", lease.runId).changes !== 1) throw new DeliveryFailure("conflict", "stale_lifecycle_state");
      this.database.prepare("UPDATE worker_leases SET state = 'completed' WHERE lease_token = ?").run(input.leaseToken);
      this.database.prepare("UPDATE workers SET status = 'online', last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), workerId);
      for (const [index, evidence] of (input.evidence ?? []).entries()) {
        this.database.prepare(
          `INSERT INTO evidence_records
           (id, run_id, attempt_id, event_id, kind, provenance, uri, content_hash, captured_at, status,
            independently_verified, completeness_note, criterion_ids)
           VALUES (?, ?, ?, ?, ?, 'worker_reported', ?, ?, ?, 'present', 0, ?, ?)`
        ).run(
          randomUUID(), lease.runId, lease.attemptId, message.id, evidence.kind,
          evidence.uri ?? null, evidence.contentHash ?? null, new Date().toISOString(),
          "Worker evidence requires orchestrator verification", JSON.stringify(evidence.criterionIds ?? [])
        );
        this.audit("worker.evidence.reported", { runId: lease.runId, attemptId: lease.attemptId, messageId: message.id, index, evidence }, {
          runId: lease.runId, attemptId: lease.attemptId, idempotencyKey: `worker.evidence:${message.id}:${index}`
        });
      }
      this.audit("run.state_changed", { runId: lease.runId, from: run.state, state: nextState, recoveryState: nextState === "inconclusive" ? "uncertain" : "none" }, {
        taskId: lease.taskId, runId: lease.runId, attemptId: lease.attemptId, correlationId: lease.runId, causationId: message.id, idempotencyKey: `run.state_changed:${lease.runId}:${run.state}:${nextState}`
      });
      this.audit("worker.reported", { ...input, messageId: message.id }, { taskId: lease.taskId, runId: lease.runId, attemptId: lease.attemptId, correlationId: lease.runId, causationId: message.id, messageId: message.id, idempotencyKey: `worker.reported:${input.leaseToken}:${input.sequence}` });
      if (input.outcome === "succeeded") {
        const revision = this.database.prepare("SELECT lifecycle_revision FROM runs WHERE id=?").get(lease.runId) as {lifecycle_revision: number};
        const evidence = this.database.prepare("SELECT id FROM evidence_records WHERE run_id=? AND attempt_id=? AND event_id=? ORDER BY id").all(lease.runId, lease.attemptId, message.id) as {id: string}[];
        new MessageDeliveryRepository(this.database).enqueue({
          schemaVersion: AGENT_MESSAGE_SCHEMA_VERSION, messageId: randomUUID(), messageType: "review.requested",
          occurredAt: new Date().toISOString(), taskId: lease.taskId, runId: lease.runId, attemptId: lease.attemptId,
          expectedRevision: revision.lifecycle_revision, correlationId: lease.runId, causationId: message.id,
          sender: {agentId: "orchestrator", role: "orchestrator"}, recipient: {agentId: "review-intake"},
          authorization: {principalId: "orchestrator", delegationChain: [], capabilityGrantId: null},
          payload: {reportMessageId: message.id, evidenceIds: evidence.map((entry) => entry.id)}
        });
      }
    })();
  }

  public async listMcpTools(workerId: string, leaseToken: string, serverId: string, approvalId?: string): Promise<readonly McpTool[]> {
    const lease = this.assertWorkerLease(workerId, leaseToken);
    const task = this.getTask(lease.taskId);
    if (!task || !task.mcpServerIds.includes(serverId)) throw new Error("MCP server is not selected for this task");
    const server = this.mcpServer(serverId);
    this.authorizeCapability({
      runId: lease.runId, task, approvalId, operation: "mcp.tools.list", target: serverId,
      args: [serverId], payload: { runId: lease.runId }, capabilityVerified: server.enabled,
      prohibited: false
    });
    const client = createMcpClient(server);
    try {
      const tools = await client.listTools();
      this.audit("mcp.tools.listed", { serverId, tools }, {
        taskId: lease.taskId, runId: lease.runId, attemptId: lease.attemptId,
        idempotencyKey: `mcp.tools.listed:${lease.runId}:${serverId}`
      });
      return tools;
    } finally {
      await client.close();
    }
  }

  public async callMcpTool(workerId: string, input: import("./contracts").McpToolRequest): Promise<McpToolResult> {
    const lease = this.assertWorkerLease(workerId, input.leaseToken);
    const task = this.getTask(lease.taskId);
    if (!task || !task.mcpServerIds.includes(input.serverId)) throw new Error("MCP server is not selected for this task");
    const invocation = { serverId: input.serverId, toolName: input.toolName, arguments: input.arguments };
    const existing = this.existingInvocation(input.idempotencyKey);
    if (existing) {
      if (JSON.stringify(existing.invocation) !== JSON.stringify(invocation)) throw new Error("MCP invocation idempotency key reused with different input");
      return existing.result as McpToolResult;
    }
    const server = this.mcpServer(input.serverId);
    this.authorizeCapability({
      runId: lease.runId, task, approvalId: input.approvalId, operation: "mcp.call", target: input.serverId,
      args: [input.serverId, input.toolName], payload: { runId: lease.runId, invocation },
      capabilityVerified: server.enabled, prohibited: isProhibitedOperation(input.toolName)
    });
    const client = createMcpClient(server);
    try {
      const result = await client.callTool(input.toolName, input.arguments);
      this.sendWorkerMessage(workerId, {
        leaseToken: input.leaseToken,
        kind: "progress",
        sequence: input.sequence,
        payload: { type: "mcp.call", invocation, result },
        idempotencyKey: input.idempotencyKey
      });
      return result;
    } catch (error) {
      try {
        this.sendWorkerMessage(workerId, {
          leaseToken: input.leaseToken,
          kind: "error",
          sequence: input.sequence,
          payload: { type: "mcp.call", invocation, error: error instanceof Error ? error.message : String(error) },
          idempotencyKey: input.idempotencyKey
        });
      } catch {
        // Preserve the original capability failure; message persistence is retried by the worker.
      }
      throw error;
    } finally {
      await client.close();
    }
  }

  public async executePlugin(workerId: string, input: import("./contracts").PluginExecutionRequest): Promise<unknown> {
    const lease = this.assertWorkerLease(workerId, input.leaseToken);
    const task = this.getTask(lease.taskId);
    if (!task || !task.pluginIds.includes(input.pluginId)) throw new Error("Plugin is not selected for this task");
    const invocation = { pluginId: input.pluginId, capability: input.capability, input: input.input };
    const existing = this.existingInvocation(input.idempotencyKey);
    if (existing) {
      if (JSON.stringify(existing.invocation) !== JSON.stringify(invocation)) throw new Error("Plugin invocation idempotency key reused with different input");
      return existing.result;
    }
    const plugin = this.plugin(input.pluginId);
    this.authorizeCapability({
      runId: lease.runId, task, approvalId: input.approvalId, operation: "plugin.execute", target: input.pluginId,
      args: [input.pluginId, input.capability], payload: { runId: lease.runId, invocation },
      capabilityVerified: plugin.enabled && plugin.capabilities.includes(input.capability),
      prohibited: isProhibitedOperation(input.capability)
    });
    try {
      const result = await executePlugin(plugin, input.capability, input.input, {
        runId: lease.runId, attemptId: lease.attemptId, taskId: lease.taskId, workerId
      });
      this.sendWorkerMessage(workerId, {
        leaseToken: input.leaseToken,
        kind: "progress",
        sequence: input.sequence,
        payload: { type: "plugin.execute", invocation, result },
        idempotencyKey: input.idempotencyKey
      });
      return result;
    } catch (error) {
      try {
        this.sendWorkerMessage(workerId, {
          leaseToken: input.leaseToken,
          kind: "error",
          sequence: input.sequence,
          payload: { type: "plugin.execute", invocation, error: error instanceof Error ? error.message : String(error) },
          idempotencyKey: input.idempotencyKey
        });
      } catch {
        // Preserve the original capability failure; message persistence is retried by the worker.
      }
      throw error;
    }
  }

  public usage(runId: string): RunUsage | null {
    const row = this.database.prepare("SELECT * FROM run_usage WHERE run_id = ?").get(runId) as {
      run_id: string; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; reasoning_tokens: number | null; recorded_at: string
    } | undefined;
    return row ? { runId: row.run_id, inputTokens: row.input_tokens, outputTokens: row.output_tokens, totalTokens: row.total_tokens, reasoningTokens: row.reasoning_tokens, recordedAt: row.recorded_at } : null;
  }

  public recordUsage(runId: string, usage: { input: number | null; output: number | null; total: number | null; reasoning: number | null }): void {
    const recordedAt = new Date().toISOString();
    this.database.prepare(
      `INSERT INTO run_usage (run_id, input_tokens, output_tokens, total_tokens, reasoning_tokens, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
       total_tokens=excluded.total_tokens, reasoning_tokens=excluded.reasoning_tokens, recorded_at=excluded.recorded_at`
    ).run(runId, usage.input, usage.output, usage.total, usage.reasoning, recordedAt);
    this.audit("run.usage.recorded", { runId, usage, recordedAt }, { runId, idempotencyKey: `run.usage:${runId}:${recordedAt}` });
  }

  private policyAction(input: {
    operation: string; target: string; args: readonly string[]; payload: unknown; riskTier: Task["riskTier"];
    prohibited: boolean; capabilityVerified: boolean; evidenceComplete: boolean; prerequisitesResolved: boolean;
  }): PolicyAction {
    return {
      operation: input.operation,
      context: {
        operation: input.operation,
        target: input.target,
        arguments: input.args,
        payload: createHash("sha256").update(JSON.stringify(input.payload)).digest("hex")
      },
      riskTier: input.riskTier,
      prohibited: input.prohibited,
      capabilityVerified: input.capabilityVerified,
      evidenceComplete: input.evidenceComplete,
      prerequisitesResolved: input.prerequisitesResolved
    };
  }

  private reconcileExpiredLeases(now: string): void {
    const expired = this.database.prepare(`SELECT l.id,l.run_id,l.attempt_id,l.task_id,l.worker_id,r.state
      FROM worker_leases l JOIN runs r ON r.id=l.run_id
      WHERE l.state='active' AND l.expires_at<=? ORDER BY l.expires_at,l.id`).all(now) as Array<{
        id: string; run_id: string; attempt_id: string; task_id: string; worker_id: string; state: Run["state"]
      }>;
    for (const lease of expired) {
      this.database.prepare("UPDATE worker_leases SET state='expired' WHERE id=? AND state='active'").run(lease.id);
      const updated = this.database.prepare(`UPDATE runs SET state='recovery_required',recovery_state='recovery_required'
        WHERE id=? AND task_id=? AND state IN ('ready','running') AND recovery_state='none'
        AND EXISTS (SELECT 1 FROM attempts a WHERE a.id=? AND a.run_id=runs.id
          AND NOT EXISTS (SELECT 1 FROM attempts newer WHERE newer.run_id=runs.id AND newer.rowid>a.rowid))
        AND NOT EXISTS (SELECT 1 FROM runs newer WHERE newer.task_id=runs.task_id AND newer.rowid>runs.rowid)`)
        .run(lease.run_id, lease.task_id, lease.attempt_id);
      if (!updated.changes) continue;
      const reason = "Worker lease expired; execution outcome is unknown and requires reconciliation";
      this.database.prepare("UPDATE attempts SET outcome='disconnected',worker_report=? WHERE id=? AND outcome='pending'").run(reason, lease.attempt_id);
      this.database.prepare(`INSERT INTO recovery (run_id,state,reason,observed_at) VALUES (?,'recovery_required',?,?)
        ON CONFLICT(run_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,observed_at=excluded.observed_at`)
        .run(lease.run_id, reason, now);
      this.database.prepare("UPDATE tasks SET status='blocked' WHERE id=? AND status IN ('intake','planned')").run(lease.task_id);
      this.audit("run.recovery_required", {runId: lease.run_id, taskId: lease.task_id, attemptId: lease.attempt_id, leaseId: lease.id, reason, observedAt: now}, {
        taskId: lease.task_id, runId: lease.run_id, attemptId: lease.attempt_id, idempotencyKey: `run.recovery_required:expired-lease:${lease.id}`
      });
    }
  }

  private hasClaimCapacity(workerId: string, now: string): boolean {
    const global = this.database.prepare("SELECT count(*) AS count FROM worker_leases WHERE state='active' AND expires_at>?").get(now) as {count: number};
    if (global.count >= this.capacity.maxActiveRuns) return false;
    const worker = this.database.prepare("SELECT count(*) AS count FROM worker_leases WHERE worker_id=? AND state='active' AND expires_at>?").get(workerId, now) as {count: number};
    return worker.count < this.capacity.maxActiveRunsPerWorker;
  }

  private authorizeCapability(input: {
    runId: string; task: Task; approvalId?: string; operation: string; target: string;
    args: readonly string[]; payload: unknown; capabilityVerified: boolean; prohibited: boolean;
  }): PolicyDecisionRecord {
    const action = this.policyAction({
      ...input,
      riskTier: input.task.riskTier,
      evidenceComplete: input.task.acceptanceCriteria.length > 0,
      prerequisitesResolved: this.taskPrerequisitesResolved(input.task)
    });
    const policy = evaluatePolicy(action);
    new PolicyRepository(this.database).recordDecision(policy);
    if (policy.decision === "allowed") {
      if (input.approvalId) throw new Error("Approval supplied for an action that does not require approval");
      return policy;
    }
    if (policy.decision === "approval_required") {
      if (!input.approvalId) throw new Error(`Approval required for ${input.operation} (run ${input.runId})`);
      new PolicyRepository(this.database).consumeApproval(input.approvalId, action, policy.policyVersion, input.runId);
      return policy;
    }
    throw new Error(`Capability action blocked by policy: ${policy.reasonCode}`);
  }

  private taskCapabilitiesEnabled(row: Record<string, unknown>): boolean {
    const groups: readonly [string, string][] = [
      ["skills", String(row.skill_ids ?? "[]")],
      ["mcp_servers", String(row.mcp_server_ids ?? "[]")],
      ["plugins", String(row.plugin_ids ?? "[]")]
    ];
    for (const [table, raw] of groups) {
      const ids = json<string[]>(raw, []);
      if (ids.length === 0) continue;
      const count = this.database.prepare(`SELECT count(*) AS count FROM ${table} WHERE enabled=1 AND id IN (${ids.map(() => "?").join(",")})`).get(...ids) as { count: number };
      if (count.count !== new Set(ids).size) return false;
    }
    return true;
  }

  private taskPrerequisitesResolved(task: Task): boolean {
    if (task.parentTaskId) {
      const parent = this.database.prepare("SELECT status FROM tasks WHERE id=?").get(task.parentTaskId) as { status: string } | undefined;
      if (parent?.status !== "completed") return false;
    }
    const unresolved = this.database.prepare(`SELECT 1 FROM task_dependencies d JOIN tasks prerequisite ON prerequisite.id=d.depends_on_task_id
      WHERE d.task_id=? AND prerequisite.status<>'completed' LIMIT 1`).get(task.id);
    return !unresolved;
  }

  private pendingRun(task: Task, row: Record<string, unknown>): { run: Run; attempt: Attempt } {
    const attemptRow = this.database.prepare("SELECT * FROM attempts WHERE run_id=? ORDER BY created_at DESC LIMIT 1").get(String(row.id)) as Record<string, unknown> | undefined;
    if (!attemptRow) throw new Error("Awaiting-approval run has no attempt");
    return {
      run: {
        id: String(row.id), taskId: task.id, state: "awaiting_approval", routeId: row.route_id ? String(row.route_id) : null,
        recoveryState: String(row.recovery_state) as Run["recoveryState"], createdAt: String(row.created_at)
      },
      attempt: {
        id: String(attemptRow.id), runId: String(attemptRow.run_id), outcome: String(attemptRow.outcome) as Attempt["outcome"],
        workerReport: attemptRow.worker_report ? String(attemptRow.worker_report) : null, createdAt: String(attemptRow.created_at)
      }
    };
  }

  private transitionRun(run: Run, state: Run["state"], task: Task): Run {
    assertRunTransition(run.state, state);
    this.database.prepare("UPDATE runs SET state=? WHERE id=? AND state=?").run(state, run.id, run.state);
    this.audit("run.state_changed", { runId: run.id, from: run.state, state, recoveryState: run.recoveryState }, {
      taskId: task.id, runId: run.id, idempotencyKey: `run.state_changed:${run.id}:${run.state}:${state}`
    });
    return { ...run, state };
  }

  private taskFromRow(row: Record<string, unknown>): Task {
    return {
      id: String(row.id), projectId: row.project_id ? String(row.project_id) : null, parentTaskId: row.parent_task_id ? String(row.parent_task_id) : null,
      title: String(row.title), description: String(row.description), acceptanceCriteria: json<string[]>(String(row.acceptance_criteria), []),
      riskTier: Number(row.risk_tier) as Task["riskTier"], status: String(row.status) as Task["status"], assignedWorkerId: row.assigned_worker_id ? String(row.assigned_worker_id) : null,
      skillIds: json<string[]>(String(row.skill_ids ?? "[]"), []), mcpServerIds: json<string[]>(String(row.mcp_server_ids ?? "[]"), []), pluginIds: json<string[]>(String(row.plugin_ids ?? "[]"), []), tokenBudget: row.token_budget === null || row.token_budget === undefined ? null : Number(row.token_budget), createdAt: String(row.created_at)
    };
  }

  private assertWorkerLease(workerId: string, leaseToken: string): WorkerLease {
    const lease = this.getActiveLease(leaseToken);
    if (lease.workerId !== workerId || lease.state !== "active") throw new Error("Worker does not own an active lease");
    if (lease.expiresAt <= new Date().toISOString()) throw new Error("Worker lease is expired");
    return lease;
  }

  private mcpServer(serverId: string): import("./contracts").McpServerRecord {
    const row = this.database.prepare("SELECT * FROM mcp_servers WHERE id = ? AND enabled = 1").get(serverId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("MCP server not found or disabled");
    return {
      id: String(row.id), name: String(row.name), transport: String(row.transport) as "stdio" | "http",
      command: row.command ? String(row.command) : null, arguments: json<string[]>(String(row.arguments_json), []),
      url: row.url ? String(row.url) : null, environment: json<Record<string, string>>(String(row.environment_json), {}),
      description: String(row.description), enabled: Number(row.enabled) === 1, createdAt: String(row.created_at)
    };
  }

  private plugin(pluginId: string): import("./contracts").PluginRecord {
    const row = this.database.prepare("SELECT * FROM plugins WHERE id = ? AND enabled = 1").get(pluginId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Plugin not found or disabled");
    return {
      id: String(row.id), name: String(row.name), version: String(row.version), entrypoint: String(row.entrypoint),
      capabilities: json<string[]>(String(row.capabilities_json), []), enabled: Number(row.enabled) === 1, createdAt: String(row.created_at)
    };
  }

  private existingInvocation(idempotencyKey: string | undefined): { invocation: unknown; result: unknown } | null {
    if (!idempotencyKey) return null;
    const row = this.database.prepare("SELECT payload_json FROM worker_messages WHERE idempotency_key = ?").get(idempotencyKey) as { payload_json: string } | undefined;
    if (!row) return null;
    const payload = JSON.parse(row.payload_json) as { invocation?: unknown; result?: unknown };
    if (!("invocation" in payload)) throw new Error("Invocation idempotency key belongs to a different message");
    return { invocation: payload.invocation, result: payload.result };
  }

  private createRun(task: Task, routeId: string): { run: Run; attempt: Attempt } {
    const now = new Date().toISOString();
    const run: Run = { id: randomUUID(), taskId: task.id, state: "created", routeId, recoveryState: "none", createdAt: now };
    const attempt: Attempt = { id: randomUUID(), runId: run.id, outcome: "pending", workerReport: null, createdAt: now };
    this.database.prepare("INSERT INTO runs (id, task_id, state, route_id, recovery_state, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(run.id, run.taskId, run.state, run.routeId, run.recoveryState, run.createdAt);
    this.database.prepare("INSERT INTO attempts (id, run_id, outcome, worker_report, created_at) VALUES (?, ?, ?, ?, ?)").run(attempt.id, attempt.runId, attempt.outcome, null, now);
    return { run, attempt };
  }

  private buildHandoff(task: Task, lease: WorkerLease) {
    const skillRows = task.skillIds.length === 0 ? [] : this.database.prepare(`SELECT id, name, version, instructions FROM skills WHERE enabled = 1 AND id IN (${task.skillIds.map(() => "?").join(",")})`).all(...task.skillIds) as Array<{ id: string; name: string; version: string; instructions: string }>;
    const mcpRows = task.mcpServerIds.length === 0 ? [] : this.database.prepare(`SELECT id, name, transport, description FROM mcp_servers WHERE enabled = 1 AND id IN (${task.mcpServerIds.map(() => "?").join(",")})`).all(...task.mcpServerIds) as Array<{ id: string; name: string; transport: "stdio" | "http"; description: string }>;
    const pluginRows = task.pluginIds.length === 0 ? [] : this.database.prepare(`SELECT id, name, version, capabilities_json FROM plugins WHERE enabled = 1 AND id IN (${task.pluginIds.map(() => "?").join(",")})`).all(...task.pluginIds) as Array<{ id: string; name: string; version: string; capabilities_json: string }>;
    const selectedPlugins = pluginRows.map((row) => ({ id: row.id, name: row.name, version: row.version, capabilities: json<string[]>(row.capabilities_json, []) }));
    return { protocolVersion: "orchestrator-worker-v1" as const, correlation: { taskId: task.id, runId: lease.runId, attemptId: lease.attemptId, leaseToken: lease.leaseToken }, acceptanceCriteria: task.acceptanceCriteria, selectedSkills: skillRows, selectedMcpServers: mcpRows, selectedPlugins, tokenBudget: task.tokenBudget };
  }

  private getActiveLease(token: string): WorkerLease {
    const row = this.database.prepare("SELECT * FROM worker_leases WHERE lease_token = ?").get(token) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Worker lease not found");
    return { id: String(row.id), runId: String(row.run_id), attemptId: String(row.attempt_id), taskId: String(row.task_id), workerId: String(row.worker_id), leaseToken: String(row.lease_token), state: String(row.state) as WorkerLease["state"], expiresAt: String(row.expires_at), lastHeartbeatAt: String(row.last_heartbeat_at), createdAt: String(row.created_at) };
  }

  private nextWorkerSequence(runId: string): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM worker_messages WHERE run_id = ? AND direction = 'worker_to_orchestrator'").get(runId) as { sequence: number };
    return row.sequence + 1;
  }

  private appendMessage(lease: WorkerLease, workerId: string | null, direction: WorkerMessage["direction"], kind: WorkerMessage["kind"], sequence: number, payload: unknown, idempotencyKey: string | null): WorkerMessage {
    if (!Number.isInteger(sequence) || sequence < 1) throw new Error("Worker message sequence is invalid");
    const message: WorkerMessage = { id: randomUUID(), runId: lease.runId, attemptId: lease.attemptId, workerId, direction, kind, sequence, payload, idempotencyKey, createdAt: new Date().toISOString() };
    try {
      if (idempotencyKey) {
        const existing = this.database.prepare("SELECT * FROM worker_messages WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, unknown> | undefined;
        if (existing) {
          if (String(existing.run_id) !== message.runId || String(existing.payload_json) !== JSON.stringify(payload)) {
            throw new Error("Worker message idempotency key reused with different payload");
          }
          return {
            id: String(existing.id), runId: String(existing.run_id), attemptId: String(existing.attempt_id), workerId: existing.worker_id ? String(existing.worker_id) : null,
            direction: String(existing.direction) as WorkerMessage["direction"], kind: String(existing.kind) as WorkerMessage["kind"], sequence: Number(existing.sequence),
            payload: JSON.parse(String(existing.payload_json)) as unknown, idempotencyKey: String(existing.idempotency_key), createdAt: String(existing.created_at)
          };
        }
      }
      this.database.prepare(`INSERT INTO worker_messages (id, run_id, attempt_id, worker_id, direction, kind, sequence, payload_json, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(message.id, message.runId, message.attemptId, message.workerId, message.direction, message.kind, message.sequence, JSON.stringify(message.payload), message.idempotencyKey, message.createdAt);
      this.audit(`worker.message.${kind}`, message, { runId: message.runId, attemptId: message.attemptId, idempotencyKey: idempotencyKey ?? `worker.message:${message.id}` });
      return message;
    } catch (error) {
      throw new PersistenceError("Worker message persistence failed", { cause: error });
    }
  }

  private audit(eventType: string, payload: unknown, options: EventCorrelation & { idempotencyKey: string }): void {
    const { idempotencyKey, ...correlation } = options;
    appendDurableEvent(this.database, eventType, payload, undefined, { correlation, idempotencyKey });
  }
}
