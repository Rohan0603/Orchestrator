import type Database from "better-sqlite3";
import type { AuditEvent } from "../shared/domain";
import { randomUUID } from "node:crypto";
import { DispatchRepository } from "../persistence/dispatch-repository";
import { EventRepository } from "../persistence/events";
import { RunRepository } from "../persistence/run-repository";
import { PolicyRepository } from "../persistence/policy-repository";
import { actionDigest, evaluatePolicy } from "../policy/policy";
import { validateProgressEvent } from "../dispatch/dispatch-contract";
import type { ProgressEvent, TerminalOutcome } from "../harness/adapter-contract";
import type { OpenAICompatibleAdapter, OpenAITraceEvent } from "../harness/openai-compatible-adapter";
import { SdkRepository } from "./repositories";
import { MessageDeliveryRepository } from "../persistence/message-delivery-repository";
import { InternalMessageDispatcher } from "../dispatch/internal-message-dispatcher";
import { createReviewIntakeConsumer } from "../dispatch/review-intake";
import type {
  CreateProjectInput,
  InstallMcpServerInput,
  InstallSkillInput,
  InstallPluginInput,
  PluginRecord,
  McpServerRecord,
  OrchestratorSdk,
  OrchestratorSdkOptions,
  Project,
  RegisterWorkerInput,
  RunStreamEvent,
  SkillRecord,
  TaskAssignment,
  TaskDependencyInfo,
  TaskRunHistoryInfo,
  TaskRevisionInfo,
  WorkerLease,
  WorkerMessage,
  WorkerMessageInput,
  WorkerRegistration,
  WorkerReportInput,
  UpdateTaskContentInput,
  LlmTaskStreamEvent
} from "./contracts";

interface AuditRow {
  id: string;
  event_type: string;
  payload: string;
  previous_hash: string | null;
  event_hash: string;
  correlation_json: string;
  idempotency_key: string | null;
  created_at: string;
}

function audit(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    payload: row.payload,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    correlation: JSON.parse(row.correlation_json) as AuditEvent["correlation"],
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at
  };
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Stream aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Stream aborted"));
    }, { once: true });
  });
}

export class OrchestratorSdkImpl implements OrchestratorSdk {
  private readonly repository: SdkRepository;

  public constructor(private readonly database: Database.Database, options: OrchestratorSdkOptions = {}) {
    const maxActiveRuns = options.maxActiveRuns ?? 1;
    const maxActiveRunsPerWorker = options.maxActiveRunsPerWorker ?? 1;
    this.repository = new SdkRepository(database, {maxActiveRuns, maxActiveRunsPerWorker});
  }

  public createProject(input: CreateProjectInput): Project {
    return this.repository.createProject(input);
  }

  public getProject(projectId: string): Project | null {
    return this.repository.getProject(projectId);
  }

  public listProjects(): readonly Project[] {
    return this.repository.listProjects();
  }

  public createTask(input: import("../shared/ipc").CreateTaskInput) {
    return this.repository.createTask(input);
  }

  public updateTask(taskId: string, input: UpdateTaskContentInput) {
    return this.repository.updateTask(taskId, input);
  }

  public getTask(taskId: string) {
    return this.repository.getTask(taskId);
  }

  public listTasks() {
    return this.repository.listTasks();
  }

  public listTaskRuns(taskId: string): readonly TaskRunHistoryInfo[] {
    return this.repository.listTaskRuns(taskId);
  }

  public listWorkerLeases(taskId?: string): readonly WorkerLease[] {
    return this.repository.listWorkerLeases(taskId);
  }

  public listTaskRevisions(taskId: string): readonly TaskRevisionInfo[] {
    return this.repository.listTaskRevisions(taskId);
  }

  public addTaskDependency(taskId: string, dependsOnTaskId: string): TaskDependencyInfo {
    return this.repository.addTaskDependency(taskId, dependsOnTaskId);
  }

  public listTaskDependencies(taskId: string): readonly TaskDependencyInfo[] {
    return this.repository.listTaskDependencies(taskId);
  }

  public registerWorker(input: RegisterWorkerInput): WorkerRegistration {
    return this.repository.registerWorker(input);
  }

  public installSkill(input: InstallSkillInput): SkillRecord {
    return this.repository.installSkill(input);
  }

  public installMcpServer(input: InstallMcpServerInput): McpServerRecord {
    return this.repository.installMcpServer(input);
  }

  public installPlugin(input: InstallPluginInput): PluginRecord {
    return this.repository.installPlugin(input);
  }

  public claimTask(workerId: string, leaseDurationMs?: number, approvalId?: string): TaskAssignment | null {
    return this.repository.claimTask(workerId, leaseDurationMs, approvalId);
  }

  public retryRecoveredTask(taskId: string, workerId: string, approvalId?: string): TaskAssignment | null {
    return this.repository.retryRecoveredTask(taskId, workerId, approvalId);
  }

  public heartbeat(leaseToken: string, leaseDurationMs?: number): WorkerLease {
    return this.repository.heartbeat(leaseToken, leaseDurationMs);
  }

  public sendWorkerMessage(workerId: string, input: WorkerMessageInput): WorkerMessage {
    return this.repository.sendWorkerMessage(workerId, input);
  }

  public reportTask(workerId: string, input: WorkerReportInput): void {
    this.repository.reportTask(workerId, input);
    this.dispatchInternalMessages();
  }

  public dispatchInternalMessages(now = new Date().toISOString(), limit = 100): readonly string[] {
    return new InternalMessageDispatcher(new MessageDeliveryRepository(this.database), {
      "review-intake": createReviewIntakeConsumer(this.database, now)
    }).dispatchDue(now, limit);
  }

  public listMcpTools(workerId: string, leaseToken: string, serverId: string, approvalId?: string): Promise<readonly import("./capability-runtime").McpTool[]> {
    return this.repository.listMcpTools(workerId, leaseToken, serverId, approvalId);
  }

  public callMcpTool(workerId: string, input: import("./contracts").McpToolRequest): Promise<import("./capability-runtime").McpToolResult> {
    return this.repository.callMcpTool(workerId, input);
  }

  public executePlugin(workerId: string, input: import("./contracts").PluginExecutionRequest): Promise<unknown> {
    return this.repository.executePlugin(workerId, input);
  }

  public async *streamTask(
    taskId: string,
    adapter: OpenAICompatibleAdapter,
    options: { readonly deadlineAt?: string; readonly systemPrompt?: string } = {}
  ): AsyncIterable<LlmTaskStreamEvent> {
    const task = this.repository.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const runs = new RunRepository(this.database);
    const dispatch = new DispatchRepository(this.database);
    const events = new EventRepository(this.database);
    const created = runs.createRun(task.id, adapter.route.routeId);
    runs.transition(created.run.id, "ready", "none");
    runs.transition(created.run.id, "running", "none");
    const running = { ...created.run, state: "running" as const };
    const correlation = {
      dispatchId: randomUUID(),
      runId: created.run.id,
      attemptId: created.attempt.id
    };
    const action = {
      operation: "llm.plan",
      context: { operation: "llm.plan", target: `task:${task.id}`, arguments: [], payload: null },
      riskTier: 1 as const,
      prohibited: false,
      capabilityVerified: true,
      evidenceComplete: true,
      prerequisitesResolved: true
    };
    const policy = evaluatePolicy(action);
    new PolicyRepository(this.database).recordDecision(policy);
    if (policy.decision !== "allowed") throw new Error(`LLM planning blocked: ${policy.reason}`);
    const authorization = {
      runId: created.run.id,
      attemptId: created.attempt.id,
      actionDigest: actionDigest(action),
      approvalId: null,
      policyVersion: "policy-v1"
    };
    const intent = {
      id: randomUUID(), dispatchId: correlation.dispatchId, idempotencyKey: randomUUID(), correlation,
      taskId: task.id, runId: created.run.id, attemptId: created.attempt.id, route: adapter.route,
      authorization, deadlineAt: options.deadlineAt ?? new Date(Date.now() + 120_000).toISOString(), state: "persisted" as const,
      createdAt: new Date().toISOString()
    };
    dispatch.persistIntent({
      intent,
      request: {
        dispatchId: intent.dispatchId,
        idempotencyKey: intent.idempotencyKey,
        authorization,
        taskDescription: this.taskPrompt(task),
        systemPrompt: options.systemPrompt ?? "You are the Orchestrator planning a bounded worker task. Return a concise, executable handoff and do not claim acceptance.",
        maxTokens: task.tokenBudget,
        deadlineAt: intent.deadlineAt,
        route: adapter.route
      }
    });
    events.append("llm.request.started", {
      taskId: task.id,
      runId: created.run.id,
      attemptId: created.attempt.id,
      route: adapter.route,
      tokenBudget: task.tokenBudget
    }, undefined, { correlation, idempotencyKey: `llm.request.started:${created.run.id}` });
    const unsubscribeTrace = adapter.subscribeTrace(correlation, (trace: OpenAITraceEvent) => {
      events.append(`llm.trace.${trace.kind}`, trace, trace.occurredAt, {
        correlation,
        idempotencyKey: `llm.trace:${created.run.id}:${trace.kind}:${trace.occurredAt}`
      });
    });
    yield { kind: "started", run: running, attempt: created.attempt };

    type QueueItem = { readonly type: "progress"; readonly value: ProgressEvent } | { readonly type: "terminal"; readonly value: TerminalOutcome };
    const queue: QueueItem[] = [];
    let terminalQueued = false;
    let wake: (() => void) | undefined;
    const push = (item: QueueItem) => {
      if (item.type === "terminal") {
        if (terminalQueued) return;
        terminalQueued = true;
      }
      queue.push(item);
      wake?.();
      wake = undefined;
    };
    const request = {
      dispatchId: intent.dispatchId,
      idempotencyKey: intent.idempotencyKey,
      authorization,
      taskDescription: this.taskPrompt(task),
      systemPrompt: options.systemPrompt ?? "You are the Orchestrator planning a bounded worker task. Return a concise, executable handoff and do not claim acceptance.",
      maxTokens: task.tokenBudget,
      deadlineAt: intent.deadlineAt,
      route: adapter.route
    };
    const dispatched = await adapter.createRun(request);
    if (!dispatched.ok) {
      unsubscribeTrace();
      runs.recordAttemptOutcome(created.attempt.id, dispatched.error.class === "ambiguous" ? "inconclusive" : "failed", dispatched.error.class === "ambiguous" ? "recovery_required" : "rejected", dispatched.error.class === "ambiguous" ? "recovery_required" : "none", dispatched.error.message);
      yield { kind: "completed", run: { ...running, state: dispatched.error.class === "ambiguous" ? "recovery_required" : "rejected" }, outcome: dispatched.error.class === "ambiguous" ? "inconclusive" : "failed" };
      return;
    }
    let cursor = dispatch.createCursor(correlation);
    const unsubscribeProgress = adapter.subscribeProgress(correlation, (event) => push({ type: "progress", value: event }));
    const unsubscribeTerminal = adapter.subscribeTerminal(correlation, (outcome) => push({ type: "terminal", value: outcome }));
    const deadlineTimer = setTimeout(() => {
      void adapter.requestCancellation(correlation, intent.deadlineAt).then((cancellation) => {
        const timeoutOutcome: TerminalOutcome = cancellation.ok && cancellation.value.state === "completed" && cancellation.value.processOwnershipVerified
          ? { kind: "timed_out", correlation, reportedAt: cancellation.value.observedAt ?? new Date().toISOString(), evidence: [], error: null }
          : {
              kind: "inconclusive",
              correlation,
              reportedAt: new Date().toISOString(),
              evidence: [],
              error: cancellation.ok
                ? cancellation.value.error ?? {
                    class: "ambiguous",
                    code: "CANCELLATION_UNVERIFIED",
                    message: "Cancellation did not verify worker termination",
                    retryable: false,
                    correlation
                  }
                : cancellation.error
            };
        push({ type: "terminal", value: timeoutOutcome });
      });
    }, Math.max(0, Date.parse(intent.deadlineAt) - Date.now()));
    try {
      while (true) {
        const item = queue.shift() ?? await new Promise<QueueItem>((resolve) => { wake = () => resolve(queue.shift()!); });
        if (item.type === "progress") {
          const validation = validateProgressEvent(item.value, cursor);
          if (validation.disposition === "accepted") {
            dispatch.recordProgress(item.value, validation);
            cursor = validation.cursor;
            events.append("llm.stream.delta", { runId: created.run.id, sequence: item.value.sequence, text: item.value.message }, undefined, { correlation, idempotencyKey: `llm.stream:${created.run.id}:${item.value.sequence}` });
            yield { kind: "delta", runId: created.run.id, sequence: item.value.sequence, text: item.value.message };
          }
          continue;
        }
        const outcome = item.value;
        const usage = adapter.getUsage(correlation);
        if (usage) {
          this.repository.recordUsage(created.run.id, usage);
          const recorded = this.repository.usage(created.run.id);
          if (recorded) yield { kind: "usage", runId: created.run.id, usage: recorded };
        }
        const nextState = outcome.kind === "succeeded" ? "verification" as const : outcome.kind === "failed" ? "rejected" as const : outcome.kind === "inconclusive" || outcome.kind === "disconnected" ? "recovery_required" as const : "inconclusive" as const;
        const attemptOutcome = outcome.kind === "succeeded" ? "succeeded" as const : outcome.kind === "failed" ? "failed" as const : outcome.kind === "cancelled" ? "cancelled" as const : "inconclusive" as const;
        runs.recordAttemptOutcome(created.attempt.id, attemptOutcome, nextState, nextState === "recovery_required" ? "recovery_required" : "none", outcome.error?.message ?? outcome.kind);
        events.append("llm.request.completed", { runId: created.run.id, outcome }, undefined, { correlation, idempotencyKey: `llm.request.completed:${created.run.id}` });
        yield { kind: "completed", run: { ...running, state: nextState }, outcome: outcome.kind === "succeeded" ? "succeeded" : outcome.kind === "failed" ? "failed" : "inconclusive" };
        return;
      }
    } finally {
      clearTimeout(deadlineTimer);
      unsubscribeProgress();
      unsubscribeTerminal();
      unsubscribeTrace();
    }
  }

  public async *streamRun(
    runId: string,
    options: { readonly pollMs?: number; readonly signal?: AbortSignal } = {}
  ): AsyncIterable<RunStreamEvent> {
    const pollMs = options.pollMs ?? 100;
    let auditCursor: { readonly createdAt: string; readonly id: string } | null = null;
    let messageCursor: { readonly createdAt: string; readonly id: string } | null = null;
    let progressCursor: { readonly occurredAt: string; readonly eventId: string } | null = null;
    let terminal = false;
    while (!terminal) {
      const auditRows = this.database.prepare(
        `SELECT * FROM audit_events
         WHERE json_extract(correlation_json, '$.runId') = ?
           AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
         ORDER BY created_at, id`
      ).all(runId, auditCursor?.createdAt ?? null, auditCursor?.createdAt ?? null, auditCursor?.createdAt ?? null, auditCursor?.id ?? "") as AuditRow[];
      const messages = this.database.prepare(
        `SELECT * FROM worker_messages
         WHERE run_id = ?
           AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
         ORDER BY created_at, id`
      ).all(runId, messageCursor?.createdAt ?? null, messageCursor?.createdAt ?? null, messageCursor?.createdAt ?? null, messageCursor?.id ?? "") as Array<{
        id: string; run_id: string; attempt_id: string; worker_id: string | null; direction: WorkerMessage["direction"];
        kind: WorkerMessage["kind"]; sequence: number; payload_json: string; idempotency_key: string | null; created_at: string
      }>;
      const progressRows = this.database.prepare(
        `SELECT event_id, payload_json, occurred_at
         FROM progress_events
         WHERE run_id = ?
           AND (? IS NULL OR occurred_at > ? OR (occurred_at = ? AND event_id > ?))
         ORDER BY occurred_at, event_id`
      ).all(runId, progressCursor?.occurredAt ?? null, progressCursor?.occurredAt ?? null, progressCursor?.occurredAt ?? null, progressCursor?.eventId ?? "") as Array<{
        event_id: string; payload_json: string; occurred_at: string
      }>;
      const pending: Array<{
        readonly at: string;
        readonly id: string;
        readonly rank: number;
        readonly source: "audit" | "worker_message" | "progress";
        readonly row: AuditRow | typeof messages[number] | typeof progressRows[number];
      }> = [
        ...auditRows.map((row) => ({at: row.created_at, id: row.id, rank: 0, source: "audit" as const, row})),
        ...progressRows.map((row) => ({at: row.occurred_at, id: row.event_id, rank: 1, source: "progress" as const, row})),
        ...messages.map((row) => ({at: row.created_at, id: row.id, rank: 2, source: "worker_message" as const, row}))
      ];
      pending.sort((left, right) => left.at.localeCompare(right.at) || left.rank - right.rank || left.id.localeCompare(right.id));
      for (const item of pending) {
        if (item.source === "audit") {
          const row = item.row as AuditRow;
          auditCursor = {createdAt: row.created_at, id: row.id};
          yield {kind: "audit", event: audit(row)};
        } else if (item.source === "progress") {
          const row = item.row as typeof progressRows[number];
          progressCursor = {occurredAt: row.occurred_at, eventId: row.event_id};
          yield {kind: "progress", event: JSON.parse(row.payload_json) as ProgressEvent};
        } else {
          const row = item.row as typeof messages[number];
          messageCursor = {createdAt: row.created_at, id: row.id};
          yield {
            kind: "worker_message",
            message: {
              id: row.id, runId: row.run_id, attemptId: row.attempt_id, workerId: row.worker_id,
              direction: row.direction, kind: row.kind, sequence: row.sequence,
              payload: JSON.parse(row.payload_json) as unknown, idempotencyKey: row.idempotency_key, createdAt: row.created_at
            }
          };
          if (row.kind === "report") terminal = true;
        }
      }
      const run = this.database.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string } | undefined;
      if (run && ["accepted", "rejected", "blocked", "inconclusive", "recovery_required"].includes(run.state)) terminal = true;
      if (!terminal) await wait(pollMs, options.signal);
    }
  }

  private taskPrompt(task: import("../shared/domain").Task): string {
    const selectedSkills = task.skillIds.length === 0 ? [] : this.database.prepare(`SELECT name, instructions FROM skills WHERE enabled = 1 AND id IN (${task.skillIds.map(() => "?").join(",")})`).all(...task.skillIds) as Array<{ name: string; instructions: string }>;
    const skillContext = selectedSkills.map((skill) => `Skill ${skill.name}:\n${skill.instructions}`).join("\n\n");
    return [
      `Task: ${task.title}`,
      task.description,
      "Acceptance criteria:",
      ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
      skillContext ? `Selected skills:\n${skillContext}` : ""
    ].filter(Boolean).join("\n\n");
  }
}

export function createOrchestratorSdk(database: Database.Database, options: OrchestratorSdkOptions = {}): OrchestratorSdk {
  return new OrchestratorSdkImpl(database, options);
}
