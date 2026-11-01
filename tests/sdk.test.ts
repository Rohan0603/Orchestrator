import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { OpenAICompatibleAdapter } from "../src/harness/openai-compatible-adapter";
import { openDatabase } from "../src/persistence/database";
import { RunRepository } from "../src/persistence/run-repository";
import { DispatchRepository } from "../src/persistence/dispatch-repository";
import { TaskRepository } from "../src/persistence/task-repository";
import { PolicyRepository } from "../src/persistence/policy-repository";
import { createApprovalRequest } from "../src/policy/policy";
import { createOrchestratorSdk } from "../src/sdk";
import { SdkRepository } from "../src/sdk/repositories";
import { createMcpClient } from "../src/sdk/capability-runtime";

test("SDK installs capabilities, claims a task, and preserves worker handoff trace", async () => {
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database);
    const project = sdk.createProject({ name: "SDK project" });
    const skill = sdk.installSkill({ name: "typescript", version: "1", sourcePath: "local", instructions: "Use strict TypeScript." });
    const mcp = sdk.installMcpServer({ name: "repo-tools", transport: "stdio", command: "repo-tools" });
    sdk.installPlugin({ name: "audit-plugin", version: "1", entrypoint: "./plugin.js", capabilities: ["audit.read"] });
    const worker = sdk.registerWorker({ name: "worker-1", capabilities: [{ key: skill.id }, { key: mcp.id }] });
    const task = new TaskRepository(database).create({
      projectId: project.id,
      title: "Implement SDK",
      description: "Build the backend SDK",
      acceptanceCriteria: ["worker reports"],
      riskTier: 1,
      skillIds: [skill.id],
      mcpServerIds: [mcp.id],
      tokenBudget: 500
    });
    const assignment = sdk.claimTask(worker.id);
    assert.ok(assignment);
    assert.equal(assignment.task.id, task.id);
    assert.equal(assignment.handoff.selectedSkills[0]?.id, skill.id);
    assert.equal(assignment.handoff.selectedMcpServers[0]?.id, mcp.id);
    assert.equal(assignment.handoff.tokenBudget, 500);
    const heartbeat = sdk.heartbeat(assignment.lease.leaseToken);
    assert.equal(heartbeat.state, "active");
    const progress = sdk.sendWorkerMessage(worker.id, {
      leaseToken: assignment.lease.leaseToken,
      kind: "progress",
      sequence: 2,
      payload: { message: "started" },
      idempotencyKey: "progress-1"
    });
    assert.equal(sdk.sendWorkerMessage(worker.id, {
      leaseToken: assignment.lease.leaseToken,
      kind: "progress",
      sequence: 2,
      payload: { message: "started" },
      idempotencyKey: "progress-1"
    }).id, progress.id);
    sdk.reportTask(worker.id, {
      leaseToken: assignment.lease.leaseToken,
      sequence: 3,
      outcome: "succeeded",
      summary: "Worker completed the task",
      source: {adapterId: "fixture-worker-adapter", sessionId: "fixture-worker-session"}
    });
    const trace: import("../src/sdk/contracts").RunStreamEvent[] = [];
    for await (const event of sdk.streamRun(assignment.run.id, { pollMs: 1 })) trace.push(event);
    assert.ok(trace.some((event) => event.kind === "audit"));
    assert.ok(trace.some((event) => event.kind === "worker_message"));
    const report = trace.find((event) => event.kind === "worker_message" && event.message.kind === "report");
    assert.ok(report?.kind === "worker_message");
    assert.equal((report.message.payload as {source: {adapterId: string; sessionId: string}}).source.adapterId, "fixture-worker-adapter");
    assert.equal((report.message.payload as {source: {adapterId: string; sessionId: string}}).source.sessionId, "fixture-worker-session");
    assert.equal((database.prepare("SELECT state FROM runs WHERE id = ?").get(assignment.run.id) as { state: string }).state, "verification");
  } finally {
    database.close();
  }
});

test("run stream includes persisted correlated adapter progress events", async () => {
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database);
    const worker = sdk.registerWorker({name: "timeline-worker"});
    sdk.createTask({title: "Timeline task", description: "Trace persisted events", acceptanceCriteria: ["progress visible"], riskTier: 1});
    const assignment = sdk.claimTask(worker.id);
    assert.ok(assignment);
    const correlation = {dispatchId: "timeline-dispatch", runId: assignment.run.id, attemptId: assignment.attempt.id};
    const dispatch = new DispatchRepository(database);
    dispatch.persistIntent({
      intent: {
        id: "timeline-intent",
        dispatchId: correlation.dispatchId,
        idempotencyKey: "timeline-idempotency",
        correlation,
        taskId: assignment.task.id,
        runId: assignment.run.id,
        attemptId: assignment.attempt.id,
        route: {routeId: "fixture", provider: {state: "known", name: "fixture"}, model: {state: "known", name: "fixture-v1"}, reportedBy: "adapter"},
        authorization: {runId: assignment.run.id, attemptId: assignment.attempt.id, actionDigest: "digest", approvalId: null, policyVersion: "policy-v1"},
        deadlineAt: "2099-01-01T00:00:00.000Z",
        state: "persisted",
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      request: {} as never
    });
    const progress = {
      eventId: "timeline-progress-1",
      correlation,
      sequence: 1,
      occurredAt: "2026-01-01T00:00:01.000Z",
      kind: "message" as const,
      message: "fixture progress",
      evidence: []
    };
    dispatch.recordProgress(progress, {disposition: "accepted", reason: "", cursor: {correlation, lastSequence: 1, eventIds: [progress.eventId]}});
    sdk.reportTask(worker.id, {leaseToken: assignment.lease.leaseToken, sequence: 1, outcome: "succeeded", summary: "finished", source: {adapterId: "timeline-fixture", sessionId: "timeline-session"}});
    const timeline = [];
    for await (const event of sdk.streamRun(assignment.run.id, {pollMs: 1})) timeline.push(event);
    const streamedProgress = timeline.find((event) => event.kind === "progress");
    assert.ok(streamedProgress?.kind === "progress");
    assert.equal(streamedProgress.event.eventId, progress.eventId);
    assert.equal(streamedProgress.event.correlation.attemptId, assignment.attempt.id);
  } finally { database.close(); }
});

test("SDK rejects expired leases and capabilities not selected for the task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-sdk-denied-"));
  const pluginPath = join(directory, "plugin.cjs");
  writeFileSync(pluginPath, "module.exports = { execute: () => 'should not run' };\n");
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database);
    const plugin = sdk.installPlugin({ name: "unselected", version: "1", entrypoint: pluginPath, capabilities: ["test.run"] });
    const worker = sdk.registerWorker({ name: "worker" });
    sdk.createTask({ title: "Lease test", description: "", acceptanceCriteria: ["blocked"], riskTier: 1 });
    const assignment = sdk.claimTask(worker.id);
    assert.ok(assignment);
    database.prepare("UPDATE worker_leases SET expires_at='2000-01-01T00:00:00.000Z' WHERE lease_token=?").run(assignment.lease.leaseToken);
    assert.throws(() => sdk.heartbeat(assignment.lease.leaseToken), /expired or inactive/);
    await assert.rejects(sdk.executePlugin(worker.id, {
      leaseToken: assignment.lease.leaseToken,
      pluginId: plugin.id,
      capability: "test.run",
      input: {},
      sequence: 1,
      idempotencyKey: "denied-plugin"
    }), /expired/);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SDK enforces default active-run capacity across tasks and workers", async () => {
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database);
    const first = sdk.registerWorker({ name: "first" });
    const second = sdk.registerWorker({ name: "second" });
    sdk.createTask({ title: "First claim", description: "", acceptanceCriteria: ["claimed once"], riskTier: 1 });
    sdk.createTask({ title: "Second claim", description: "", acceptanceCriteria: ["capacity held"], riskTier: 1 });
    const claims = await Promise.all([
      Promise.resolve().then(() => sdk.claimTask(first.id)),
      Promise.resolve().then(() => sdk.claimTask(second.id))
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((database.prepare("SELECT count(*) AS count FROM worker_leases WHERE state = 'active'").get() as { count: number }).count, 1);
    assert.equal((database.prepare("SELECT count(*) AS count FROM runs WHERE state='running'").get() as { count: number }).count, 1);
  } finally {
    database.close();
  }
});

test("SDK does not reclaim a verified worker report while review is acknowledged or deferred", () => {
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database);
    const worker = sdk.registerWorker({name: "review-fenced-worker"});
    const task = sdk.createTask({title: "Review fence", description: "", acceptanceCriteria: ["review"], riskTier: 1});
    const assignment = sdk.claimTask(worker.id);
    assert.ok(assignment);
    sdk.reportTask(worker.id, {leaseToken: assignment.lease.leaseToken, sequence: 1, outcome: "succeeded", summary: "Done", source: {adapterId: "review-fixture", sessionId: assignment.run.id}});
    assert.equal((database.prepare("SELECT status FROM message_deliveries WHERE task_id=?").get(task.id) as {status: string}).status, "acknowledged");
    assert.equal(sdk.claimTask(worker.id), null);
    assert.equal((database.prepare("SELECT count(*) AS count FROM runs WHERE task_id=?").get(task.id) as {count: number}).count, 1);
  } finally { database.close(); }

  const deferredDb = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(deferredDb);
    const worker = sdk.registerWorker({name: "deferred-review-worker"});
    const task = sdk.createTask({title: "Deferred review fence", description: "", acceptanceCriteria: ["review"], riskTier: 1});
    const assignment = sdk.claimTask(worker.id);
    assert.ok(assignment);
    new SdkRepository(deferredDb).reportTask(worker.id, {leaseToken: assignment.lease.leaseToken, sequence: 1, outcome: "succeeded", summary: "Done", source: {adapterId: "review-fixture", sessionId: assignment.run.id}});
    assert.equal((deferredDb.prepare("SELECT status FROM message_deliveries WHERE task_id=?").get(task.id) as {status: string}).status, "pending");
    assert.equal(sdk.claimTask(worker.id), null);
    assert.equal((deferredDb.prepare("SELECT count(*) AS count FROM runs WHERE task_id=?").get(task.id) as {count: number}).count, 1);
  } finally { deferredDb.close(); }
});

test("SDK exposes persisted state, revisions task content, and gates claims on dependency completion", () => {
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database);
    const project = sdk.createProject({name: "Queryable project"});
    const dependent = sdk.createTask({projectId: project.id, title: "Dependent task", description: "initial", acceptanceCriteria: ["ready"], riskTier: 1, idempotencyKey: "dependent-task"});
    const prerequisite = sdk.createTask({projectId: project.id, title: "Prerequisite", description: "", acceptanceCriteria: ["complete"], riskTier: 1});
    database.prepare("UPDATE tasks SET created_at=? WHERE id=?").run("2026-01-01T00:00:00.000Z", dependent.id);
    sdk.updateTask(dependent.id, {title: "Dependent task revised"});
    assert.equal(sdk.getProject(project.id)?.id, project.id);
    assert.equal(sdk.listProjects().length, 1);
    assert.equal(sdk.getTask(dependent.id)?.title, "Dependent task revised");
    assert.equal(sdk.listTasks().length, 2);
    const revisions = sdk.listTaskRevisions(dependent.id);
    assert.equal(revisions.length, 2);
    assert.notEqual(revisions[0]?.contentHash, revisions[1]?.contentHash);
    sdk.addTaskDependency(dependent.id, prerequisite.id);
    assert.equal(sdk.listTaskDependencies(dependent.id).length, 1);

    const worker = sdk.registerWorker({name: "dependency-worker"});
    assert.throws(() => sdk.claimTask(worker.id), /blocked by policy/i);
    assert.ok(database.prepare("SELECT 1 FROM policy_decisions WHERE reason_code='UNRESOLVED_PREREQUISITE'").get());
    assert.equal(sdk.listWorkerLeases(dependent.id).length, 0);
    new TaskRepository(database).updateStatus(prerequisite.id, "completed");
    new TaskRepository(database).updateStatus(dependent.id, "planned");
    const assignment = sdk.claimTask(worker.id);
    assert.equal(assignment?.task.id, dependent.id);
    assert.equal(sdk.listTaskRuns(dependent.id).length, 2);
    assert.equal(sdk.listWorkerLeases(dependent.id).length, 1);
  } finally { database.close(); }
});

test("SDK capacity is shared across independent SQLite connections and worker claims", () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-capacity-"));
  const path = join(directory, "state.sqlite");
  const firstDb = openDatabase(path);
  const secondDb = openDatabase(path);
  try {
    const options = {maxActiveRuns: 2, maxActiveRunsPerWorker: 1};
    const firstSdk = createOrchestratorSdk(firstDb, options);
    const secondSdk = createOrchestratorSdk(secondDb, options);
    const firstWorker = firstSdk.registerWorker({name: "capacity-first"});
    const secondWorker = firstSdk.registerWorker({name: "capacity-second"});
    const thirdWorker = firstSdk.registerWorker({name: "capacity-third"});
    firstSdk.createTask({title: "Capacity one", description: "", acceptanceCriteria: ["one"], riskTier: 1});
    firstSdk.createTask({title: "Capacity two", description: "", acceptanceCriteria: ["two"], riskTier: 1});
    firstSdk.createTask({title: "Capacity three", description: "", acceptanceCriteria: ["three"], riskTier: 1});

    assert.ok(firstSdk.claimTask(firstWorker.id));
    assert.ok(secondSdk.claimTask(secondWorker.id));
    assert.equal(firstSdk.claimTask(firstWorker.id), null);
    assert.equal(secondSdk.claimTask(thirdWorker.id), null);
    assert.equal((firstDb.prepare("SELECT count(*) AS count FROM worker_leases WHERE state='active'").get() as {count: number}).count, 2);
  } finally {
    secondDb.close();
    firstDb.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test("SDK fences expired worker execution across file-backed reopen until an authorized retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-expired-run-"));
  const databasePath = join(directory, "state.sqlite");
  let database = openDatabase(databasePath);
  try {
    let sdk = createOrchestratorSdk(database);
    const worker = sdk.registerWorker({ name: "restart-worker" });
    sdk.createTask({ title: "Restart", description: "", acceptanceCriteria: ["no stale lease"], riskTier: 1 });
    const assignment = sdk.claimTask(worker.id);
    assert.ok(assignment);
    database.prepare("UPDATE worker_leases SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", assignment.lease.id);
    assert.throws(() => sdk.heartbeat(assignment.lease.leaseToken), /expired or inactive/);
    database.close();
    database = openDatabase(databasePath);
    sdk = createOrchestratorSdk(database);
    assert.equal(sdk.claimTask(worker.id), null);
    assert.equal((database.prepare("SELECT count(*) AS count FROM worker_leases WHERE state = 'active'").get() as { count: number }).count, 0);
    assert.deepEqual(database.prepare("SELECT state,recovery_state FROM runs WHERE id=?").get(assignment.run.id), {state: "recovery_required", recovery_state: "recovery_required"});
    assert.equal((database.prepare("SELECT outcome FROM attempts WHERE id=?").get(assignment.attempt.id) as { outcome: string }).outcome, "disconnected");
    assert.equal((database.prepare("SELECT status FROM tasks WHERE id=?").get(assignment.task.id) as { status: string }).status, "blocked");
    assert.equal((database.prepare("SELECT state FROM recovery WHERE run_id=?").get(assignment.run.id) as { state: string }).state, "recovery_required");

    new RunRepository(database).recordRecoveryOutcome(assignment.run.id, "reconciled", "Worker exit verified by the orchestrator", new Date().toISOString());
    const retry = sdk.retryRecoveredTask(assignment.task.id, worker.id);
    assert.ok(retry);
    assert.notEqual(retry.run.id, assignment.run.id);
    assert.equal((database.prepare("SELECT state FROM runs WHERE id=?").get(assignment.run.id) as { state: string }).state, "blocked");
    assert.equal((database.prepare("SELECT count(*) AS count FROM runs WHERE task_id=? AND state='running'").get(assignment.task.id) as { count: number }).count, 1);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SDK executes selected stdio MCP tools and plugins through the worker lease", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-sdk-capabilities-"));
  const mcpPath = join(directory, "mcp-fixture.cjs");
  const pluginPath = join(directory, "plugin-fixture.cjs");
  writeFileSync(mcpPath, [
    "const readline = require('node:readline');",
    "const input = readline.createInterface({ input: process.stdin });",
    "input.on('line', (line) => {",
    "  const request = JSON.parse(line);",
    "  if (request.id === undefined) return;",
    "  let result;",
    "  if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };",
    "  else if (request.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object' } }] };",
    "  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: String(request.params.arguments.value) }] };",
    "  else result = {};",
    "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');",
    "});"
  ].join("\n"));
  writeFileSync(pluginPath, "module.exports = { execute: (capability, input, context) => ({ capability, input, runId: context.runId }) };\n");
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database);
    const mcp = sdk.installMcpServer({
      name: "fixture-mcp",
      transport: "stdio",
      command: "node",
      arguments: [mcpPath]
    });
    const plugin = sdk.installPlugin({
      name: "fixture-plugin",
      version: "1",
      entrypoint: pluginPath,
      capabilities: ["fixture.echo"]
    });
    const worker = sdk.registerWorker({ name: "capability-worker", capabilities: [{ key: mcp.id }, { key: plugin.id }] });
    const task = sdk.createTask({
      title: "Use capabilities",
      description: "Exercise selected MCP and plugin capabilities",
      acceptanceCriteria: ["capabilities report results"],
      riskTier: 1,
      mcpServerIds: [mcp.id],
      pluginIds: [plugin.id]
    });
    const assignment = sdk.claimTask(worker.id);
    assert.ok(assignment);
    assert.equal(assignment.handoff.selectedPlugins[0]?.id, plugin.id);

    const tools = await sdk.listMcpTools(worker.id, assignment.lease.leaseToken, mcp.id);
    assert.equal(tools[0]?.name, "echo");
    const toolResult = await sdk.callMcpTool(worker.id, {
      leaseToken: assignment.lease.leaseToken,
      serverId: mcp.id,
      toolName: "echo",
      arguments: { value: "hello" },
      sequence: 1,
      idempotencyKey: "mcp-call-1"
    });
    assert.deepEqual(toolResult.content, [{ type: "text", text: "hello" }]);
    const pluginResult = await sdk.executePlugin(worker.id, {
      leaseToken: assignment.lease.leaseToken,
      pluginId: plugin.id,
      capability: "fixture.echo",
      input: { value: 42 },
      sequence: 2,
      idempotencyKey: "plugin-call-1"
    });
    assert.deepEqual(pluginResult, { capability: "fixture.echo", input: { value: 42 }, runId: assignment.run.id });
    assert.deepEqual(await sdk.executePlugin(worker.id, {
      leaseToken: assignment.lease.leaseToken,
      pluginId: plugin.id,
      capability: "fixture.echo",
      input: { value: 42 },
      sequence: 2,
      idempotencyKey: "plugin-call-1"
    }), pluginResult);
    sdk.reportTask(worker.id, {
      leaseToken: assignment.lease.leaseToken,
      sequence: 3,
      outcome: "succeeded",
      summary: "MCP and plugin completed",
      source: {adapterId: "sdk-capability-fixture", sessionId: assignment.run.id}
    });
    assert.equal((database.prepare("SELECT count(*) AS count FROM worker_messages WHERE run_id = ?").get(assignment.run.id) as { count: number }).count, 4);
    assert.equal(task.id, assignment.task.id);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SDK keeps a high-risk task awaiting approval until the exact one-shot claim approval is consumed", () => {
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database);
    const worker = sdk.registerWorker({ name: "high-risk-worker" });
    const task = sdk.createTask({ title: "High risk", description: "", acceptanceCriteria: ["approved"], riskTier: 3 });

    assert.throws(() => sdk.claimTask(worker.id), /approval required/i);
    const pending = database.prepare("SELECT id, state FROM runs WHERE task_id=?").get(task.id) as { id: string; state: string };
    assert.equal(pending.state, "awaiting_approval");
    assert.equal((database.prepare("SELECT count(*) AS count FROM worker_leases WHERE task_id=?").get(task.id) as { count: number }).count, 0);
    const decision = database.prepare("SELECT action_json FROM policy_decisions ORDER BY evaluated_at DESC LIMIT 1").get() as { action_json: string };
    const action = JSON.parse(decision.action_json);
    const approvals = new PolicyRepository(database);
    const approval = approvals.createApproval(createApprovalRequest(pending.id, action, "policy-v1", "2099-01-01T00:00:00.000Z"));
    assert.throws(() => approvals.consumeApproval(approval.id, action, "policy-v1", "different-run"), /APPROVAL_RUN_MISMATCH/);

    const assignment = sdk.claimTask(worker.id, 60_000, approval.id);
    assert.ok(assignment);
    assert.equal(assignment.run.id, pending.id);
    assert.equal(assignment.run.state, "running");
    assert.ok((database.prepare("SELECT consumed_at FROM approvals WHERE id=?").get(approval.id) as { consumed_at: string | null }).consumed_at);
  } finally {
    database.close();
  }
});

test("SDK blocks worker claims for an unsupported execution route", () => {
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database);
    const worker = sdk.registerWorker({ name: "unsupported-route-worker", kind: "external-adapter" });
    const task = sdk.createTask({ title: "Unqualified route", description: "", acceptanceCriteria: ["blocked"], riskTier: 1 });

    assert.throws(() => sdk.claimTask(worker.id), /blocked by policy/i);
    assert.equal((database.prepare("SELECT state FROM runs WHERE task_id=?").get(task.id) as { state: string }).state, "blocked");
    assert.equal((database.prepare("SELECT status FROM tasks WHERE id=?").get(task.id) as { status: string }).status, "blocked");
    assert.equal((database.prepare("SELECT count(*) AS count FROM worker_leases WHERE task_id=?").get(task.id) as { count: number }).count, 0);
    assert.ok(database.prepare("SELECT 1 FROM policy_decisions WHERE decision='denied'").get());
  } finally {
    database.close();
  }
});

test("SDK blocks prohibited plugin capabilities before executing plugin code", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-sdk-prohibited-plugin-"));
  const markerPath = join(directory, "executed.txt");
  const pluginPath = join(directory, "plugin.cjs");
  writeFileSync(pluginPath, `const fs = require('node:fs'); module.exports = { execute: () => { fs.writeFileSync(${JSON.stringify(markerPath)}, 'ran'); return 'ran'; } };\n`);
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database);
    const plugin = sdk.installPlugin({ name: "dangerous-plugin", version: "1", entrypoint: pluginPath, capabilities: ["git.push.force"] });
    const worker = sdk.registerWorker({ name: "plugin-worker", capabilities: [{ key: plugin.id }] });
    const task = sdk.createTask({ title: "Dangerous capability", description: "", acceptanceCriteria: ["blocked"], riskTier: 1, pluginIds: [plugin.id] });
    const assignment = sdk.claimTask(worker.id);
    assert.ok(assignment);

    await assert.rejects(sdk.executePlugin(worker.id, {
      leaseToken: assignment.lease.leaseToken,
      pluginId: plugin.id,
      capability: "git.push.force",
      input: {},
      sequence: 1,
      idempotencyKey: "prohibited-plugin"
    }), /prohibited|denied/i);
    assert.equal(existsSync(markerPath), false);
    assert.ok(database.prepare("SELECT 1 FROM policy_decisions WHERE decision='denied'").get());
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SDK requires exact approval before high-risk plugin code and deduplicates the approved replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-sdk-plugin-approval-"));
  const markerPath = join(directory, "executions.txt");
  const pluginPath = join(directory, "plugin.cjs");
  writeFileSync(pluginPath, `const fs = require('node:fs'); module.exports = { execute: () => { fs.appendFileSync(${JSON.stringify(markerPath)}, 'run\\n'); return 'approved'; } };\n`);
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database);
    const plugin = sdk.installPlugin({ name: "approved-plugin", version: "1", entrypoint: pluginPath, capabilities: ["audit.write"] });
    const worker = sdk.registerWorker({ name: "approved-worker", capabilities: [{ key: plugin.id }] });
    const task = sdk.createTask({ title: "High risk plugin", description: "", acceptanceCriteria: ["approved"], riskTier: 2, pluginIds: [plugin.id] });
    assert.throws(() => sdk.claimTask(worker.id), /approval required/i);
    const run = database.prepare("SELECT id FROM runs WHERE task_id=?").get(task.id) as { id: string };
    const claimAction = JSON.parse((database.prepare("SELECT action_json FROM policy_decisions WHERE json_extract(action_json, '$.operation')='worker.claim' ORDER BY evaluated_at DESC LIMIT 1").get() as { action_json: string }).action_json);
    const policies = new PolicyRepository(database);
    const claimApproval = policies.createApproval(createApprovalRequest(run.id, claimAction, "policy-v1", "2099-01-01T00:00:00.000Z"));
    const assignment = sdk.claimTask(worker.id, 60_000, claimApproval.id);
    assert.ok(assignment);

    const request = {
      leaseToken: assignment.lease.leaseToken,
      pluginId: plugin.id,
      capability: "audit.write",
      input: { record: "review" },
      sequence: 1,
      idempotencyKey: "approved-plugin-call"
    };
    await assert.rejects(sdk.executePlugin(worker.id, request), /approval required/i);
    assert.equal(existsSync(markerPath), false);
    const callAction = JSON.parse((database.prepare("SELECT action_json FROM policy_decisions WHERE json_extract(action_json, '$.operation')='plugin.execute' ORDER BY evaluated_at DESC LIMIT 1").get() as { action_json: string }).action_json);
    const callApproval = policies.createApproval(createApprovalRequest(assignment.run.id, callAction, "policy-v1", "2099-01-01T00:00:00.000Z"));
    assert.equal(await sdk.executePlugin(worker.id, { ...request, approvalId: callApproval.id }), "approved");
    assert.equal(await sdk.executePlugin(worker.id, request), "approved");
    assert.equal(readFileSync(markerPath, "utf8"), "run\n");
    assert.ok((database.prepare("SELECT consumed_at FROM approvals WHERE id=?").get(callApproval.id) as { consumed_at: string | null }).consumed_at);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP MCP adapter performs initialize, session tracking, listing, and tool calls", async () => {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: unknown };
      if (message.method === "notifications/initialized") {
        response.statusCode = 202;
        response.end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Mcp-Session-Id", "fixture-session");
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1" } }
        : message.method === "tools/list"
          ? { tools: [{ name: "status", description: "Return status" }] }
          : { content: [{ type: "text", text: "ok" }] };
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = createMcpClient({
    id: "http-fixture",
    name: "http-fixture",
    transport: "http",
    command: null,
    arguments: [],
    url: `http://127.0.0.1:${address.port}`,
    environment: {},
    description: "fixture",
    enabled: true,
    createdAt: new Date().toISOString()
  });
  try {
    assert.equal((await client.listTools())[0]?.name, "status");
    assert.deepEqual(await client.callTool("status", {}), { content: [{ type: "text", text: "ok" }], isError: false, structuredContent: undefined });
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("SDK streams freellmapi response, records usage, and never marks acceptance", async () => {
  const database = openDatabase(":memory:");
  try {
    const task = new TaskRepository(database).create({
      title: "Plan task",
      description: "Produce a concise plan",
      acceptanceCriteria: ["plan is returned"],
      riskTier: 1,
      tokenBudget: 120
    });
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "http://127.0.0.1:31415/v1",
      apiKey: "test-key",
      model: "auto",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => {
            let read = false;
            return {
              read: async () => read
                ? { done: true, value: undefined }
                : (read = true, { done: false, value: new TextEncoder().encode([
                  'data: {"choices":[{"delta":{"content":"plan"}}]}',
                  '',
                  'data: {"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
                  '',
                  'data: [DONE]',
                  '',
                  ''
                ].join("\n")) })
            };
          }
        }
      } as unknown as Response)
    });
    const events = [];
    for await (const event of createOrchestratorSdk(database).streamTask(task.id, adapter)) events.push(event);
    assert.deepEqual(events.map((event) => event.kind), ["started", "delta", "usage", "completed"]);
    const usage = database.prepare("SELECT input_tokens, output_tokens, total_tokens FROM run_usage").get() as { input_tokens: number; output_tokens: number; total_tokens: number };
    assert.deepEqual(usage, { input_tokens: 4, output_tokens: 2, total_tokens: 6 });
    assert.ok((database.prepare("SELECT count(*) AS count FROM audit_events WHERE event_type LIKE 'llm.trace.%'").get() as { count: number }).count >= 3);
    assert.deepEqual(database.prepare("SELECT count(*) AS count FROM acceptance_decisions").get(), { count: 0 });
    await adapter.close();
  } finally {
    database.close();
  }
});

test("successful report atomically emits and consumes a correlated review request", () => {
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database);
    const worker = sdk.registerWorker({name: "review-worker"});
    sdk.createTask({title: "Review slice", description: "", acceptanceCriteria: ["review requested"], riskTier: 1});
    const assignment = sdk.claimTask(worker.id)!;
    const input = {leaseToken: assignment.lease.leaseToken, sequence: 1, outcome: "succeeded" as const, summary: "done", source: {adapterId: "review-fixture", sessionId: assignment.run.id}};
    sdk.reportTask(worker.id, input);
    const request = database.prepare("SELECT * FROM review_requests WHERE run_id=?").get(assignment.run.id) as {message_id: string; correlation_id: string; causation_id: string; report_message_id: string};
    assert.ok(request);
    assert.equal(request.correlation_id, assignment.run.id); assert.equal(request.causation_id, request.report_message_id);
    assert.deepEqual(database.prepare("SELECT status FROM message_deliveries").get(), {status: "acknowledged"});
    assert.deepEqual(database.prepare("SELECT state FROM runs WHERE id=?").get(assignment.run.id), {state: "verification"});
    assert.deepEqual(database.prepare("SELECT COUNT(*) AS n FROM acceptance_decisions").get(), {n: 0});
    sdk.reportTask(worker.id, input);
    assert.deepEqual(database.prepare("SELECT COUNT(*) AS n FROM review_requests").get(), {n: 1});
    const audit = database.prepare("SELECT correlation_json FROM audit_events WHERE event_type='internal.message.processed'").get() as {correlation_json: string};
    assert.equal(JSON.parse(audit.correlation_json).causationId, request.message_id);
  } finally { database.close(); }
});

test("failed semantic enqueue rolls back worker report and producer lifecycle changes", () => {
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database), worker = sdk.registerWorker({name: "rollback-worker"});
    sdk.createTask({title: "Rollback", description: "", acceptanceCriteria: ["atomic"], riskTier: 1});
    const assignment = sdk.claimTask(worker.id)!;
    database.exec("CREATE TRIGGER reject_semantic BEFORE INSERT ON outbox WHEN NEW.event_type='internal.message' BEGIN SELECT RAISE(ABORT,'injected enqueue failure'); END");
    const input = {leaseToken: assignment.lease.leaseToken, sequence: 1, outcome: "succeeded" as const, summary: "done", source: {adapterId: "review-fixture", sessionId: assignment.run.id}};
    assert.throws(() => sdk.reportTask(worker.id, input), /injected/);
    assert.deepEqual(database.prepare("SELECT state FROM runs WHERE id=?").get(assignment.run.id), {state: "running"});
    assert.deepEqual(database.prepare("SELECT COUNT(*) AS n FROM worker_messages WHERE kind='report'").get(), {n: 0});
    assert.deepEqual(database.prepare("SELECT state FROM worker_leases").get(), {state: "active"});
    database.exec("DROP TRIGGER reject_semantic"); sdk.reportTask(worker.id, input);
    assert.deepEqual(database.prepare("SELECT COUNT(*) AS n FROM review_requests").get(), {n: 1});
  } finally { database.close(); }
});

test("late worker reports cannot supersede a newer authoritative attempt", () => {
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database), worker = sdk.registerWorker({name: "late-worker"});
    sdk.createTask({title: "Stale", description: "", acceptanceCriteria: ["authority"], riskTier: 1});
    const assignment = sdk.claimTask(worker.id)!;
    database.prepare("INSERT INTO attempts (id,run_id,outcome,created_at) VALUES ('new-authority',?,'pending',?)").run(assignment.run.id, assignment.attempt.createdAt);
    assert.throws(() => sdk.reportTask(worker.id, {leaseToken: assignment.lease.leaseToken, sequence: 1, outcome: "succeeded", summary: "late", source: {adapterId: "review-fixture", sessionId: assignment.run.id}}), /stale|authoritative/i);
    assert.deepEqual(database.prepare("SELECT state FROM runs WHERE id=?").get(assignment.run.id), {state: "running"});
    assert.deepEqual(database.prepare("SELECT COUNT(*) AS n FROM worker_messages WHERE kind='report'").get(), {n: 0});
  } finally { database.close(); }
});

test("a preexisting worker report message cannot masquerade as a committed lifecycle report", () => {
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database), worker = sdk.registerWorker({name: "preexisting-report"});
    sdk.createTask({title: "Report provenance", description: "", acceptanceCriteria: ["atomic completion"], riskTier: 1});
    const assignment = sdk.claimTask(worker.id)!;
    const input = {leaseToken: assignment.lease.leaseToken, sequence: 1, outcome: "succeeded" as const, summary: "done", source: {adapterId: "review-fixture", sessionId: assignment.run.id}};
    sdk.sendWorkerMessage(worker.id, {leaseToken: input.leaseToken, sequence: 1, kind: "report", payload: input, idempotencyKey: `report:${input.leaseToken}:1`});
    sdk.reportTask(worker.id, input);
    assert.deepEqual(database.prepare("SELECT state FROM runs WHERE id=?").get(assignment.run.id), {state: "verification"});
    assert.deepEqual(database.prepare("SELECT COUNT(*) AS n FROM review_requests").get(), {n: 1});
  } finally { database.close(); }
});
