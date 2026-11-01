import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { openDatabase } from "./persistence/database";
import { createOrchestratorSdk } from "./sdk";
import type { OrchestratorSdk } from "./sdk/contracts";

export interface CliIO {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}
const defaultIO: CliIO = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value)
};

interface TraceItem {
  readonly at: string;
  readonly kind: string;
  readonly source: "audit" | "progress" | "worker_message";
  readonly id: string;
  readonly correlation: unknown;
  readonly payload: unknown;
}

function json(io: CliIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function parseFlags(args: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Expected a value after ${flag ?? "option"}`);
    }
    const key = flag.slice(2);
    if (key in flags) throw new Error(`Duplicate option ${flag}`);
    flags[key] = value;
  }
  return flags;
}

function required(flags: Record<string, string>, key: string): string {
  const value = flags[key]?.trim();
  if (!value) throw new Error(`Missing required option --${key}`);
  return value;
}

function trace(database: Database.Database, runId: string): readonly TraceItem[] {
  const auditRows = database.prepare(`SELECT id,event_type,created_at,payload,correlation_json
    FROM audit_events WHERE json_extract(correlation_json,'$.runId')=? ORDER BY created_at,id`).all(runId) as Array<{
      id: string; event_type: string; created_at: string; payload: string; correlation_json: string
    }>;
  const progressRows = database.prepare(`SELECT event_id,kind,occurred_at,payload_json
    FROM progress_events WHERE run_id=? ORDER BY occurred_at,event_id`).all(runId) as Array<{
      event_id: string; kind: string; occurred_at: string; payload_json: string
    }>;
  const messageRows = database.prepare(`SELECT id,kind,created_at,payload_json,run_id,attempt_id,worker_id,direction,sequence
    FROM worker_messages WHERE run_id=? ORDER BY created_at,id`).all(runId) as Array<{
      id: string; kind: string; created_at: string; payload_json: string; run_id: string; attempt_id: string;
      worker_id: string | null; direction: string; sequence: number
    }>;
  return [
    ...auditRows.map((row): TraceItem => ({at: row.created_at, kind: row.event_type, source: "audit", id: row.id,
      correlation: JSON.parse(row.correlation_json) as unknown, payload: JSON.parse(row.payload) as unknown})),
    ...progressRows.map((row): TraceItem => {
      const event = JSON.parse(row.payload_json) as {correlation?: unknown};
      return {at: row.occurred_at, kind: row.kind, source: "progress", id: row.event_id,
        correlation: event.correlation ?? null, payload: event};
    }),
    ...messageRows.map((row): TraceItem => ({at: row.created_at, kind: row.kind, source: "worker_message", id: row.id,
      correlation: {runId: row.run_id, attemptId: row.attempt_id, workerId: row.worker_id, direction: row.direction, sequence: row.sequence},
      payload: JSON.parse(row.payload_json) as unknown}))
  ].sort((left, right) => left.at.localeCompare(right.at) || left.source.localeCompare(right.source) || left.id.localeCompare(right.id));
}

function taskDetails(database: Database.Database, sdk: OrchestratorSdk, taskId: string): unknown {
  const task = sdk.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const runs = sdk.listTaskRuns(taskId);
  return {
    task,
    revisions: sdk.listTaskRevisions(taskId),
    dependencies: sdk.listTaskDependencies(taskId),
    runs,
    leases: sdk.listWorkerLeases(taskId),
    traces: runs.map(({run}) => ({runId: run.id, timeline: trace(database, run.id)})),
    artifacts: runs.flatMap(({run}) => database.prepare(`SELECT id,run_id,attempt_id,event_id,kind,provenance,uri,content_hash,status,
        independently_verified,captured_at FROM evidence_records WHERE run_id=? ORDER BY captured_at,id`).all(run.id))
  };
}

async function execute(database: Database.Database, sdk: OrchestratorSdk, args: readonly string[], io: CliIO): Promise<void> {
  const [area, action, ...rest] = args;
  if (area === "project" && action === "list" && rest.length === 0) {
    json(io, sdk.listProjects());
    return;
  }
  if (area === "project" && action === "show" && rest.length === 1) {
    const project = sdk.getProject(rest[0]!);
    if (!project) throw new Error(`Project ${rest[0]} not found`);
    const tasks = sdk.listTasks().filter((task) => task.projectId === project.id);
    json(io, {project, tasks: tasks.map((task) => taskDetails(database, sdk, task.id))});
    return;
  }
  if (area === "project" && action === "create") {
    const flags = parseFlags(rest);
    json(io, sdk.createProject({name: required(flags, "name"), description: flags.description ?? ""}));
    return;
  }
  if (area === "task" && action === "list") {
    const flags = parseFlags(rest);
    const tasks = sdk.listTasks();
    json(io, flags.project
      ? tasks.filter((task) => task.projectId === flags.project)
      : tasks);
    return;
  }
  if (area === "task" && action === "show" && rest.length === 1) {
    json(io, taskDetails(database, sdk, rest[0]!));
    return;
  }
  if (area === "task" && action === "create") {
    const flags = parseFlags(rest);
    const criteria = required(flags, "criteria").split("|").map((criterion) => criterion.trim()).filter(Boolean);
    const riskTier = Number(required(flags, "risk-tier"));
    if (!Number.isInteger(riskTier) || riskTier < 1 || riskTier > 3) throw new Error("--risk-tier must be 1, 2, or 3");
    json(io, sdk.createTask({
      projectId: required(flags, "project"),
      title: required(flags, "title"),
      description: flags.description ?? "",
      acceptanceCriteria: criteria,
      riskTier: riskTier as 1 | 2 | 3
    }));
    return;
  }
  if (area === "run" && action === "list") {
    const flags = parseFlags(rest);
    const tasks = flags.task ? sdk.listTasks().filter((task) => task.id === flags.task) : sdk.listTasks();
    json(io, tasks.flatMap((task) => sdk.listTaskRuns(task.id).map((run) => ({taskId: task.id, taskTitle: task.title, ...run}))));
    return;
  }
  if (area === "run" && action === "show" && rest.length === 1) {
    const run = database.prepare("SELECT * FROM runs WHERE id=?").get(rest[0]);
    if (!run) throw new Error(`Run ${rest[0]} not found`);
    const attempts = database.prepare("SELECT * FROM attempts WHERE run_id=? ORDER BY created_at,rowid").all(rest[0]);
    const taskId = (run as {task_id: string}).task_id;
    json(io, {run, attempts, task: sdk.getTask(taskId), leases: sdk.listWorkerLeases(taskId), timeline: trace(database, rest[0]!)});
    return;
  }
  if (area === "run" && action === "trace" && rest.length === 1) {
    const exists = database.prepare("SELECT 1 FROM runs WHERE id=?").get(rest[0]);
    if (!exists) throw new Error(`Run ${rest[0]} not found`);
    json(io, trace(database, rest[0]!));
    return;
  }
  if (area === "fixture" && action === "demo" && rest.length === 0) {
    const dispatchable = database.prepare(`SELECT 1 FROM tasks
      WHERE status IN ('intake','planned')
        AND NOT EXISTS (SELECT 1 FROM worker_leases WHERE worker_leases.task_id=tasks.id AND state='active')
        AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.task_id=tasks.id AND state NOT IN ('blocked','awaiting_approval'))
        AND NOT EXISTS (SELECT 1 FROM message_deliveries WHERE message_deliveries.task_id=tasks.id AND status<>'acknowledged')
      LIMIT 1`).get();
    if (dispatchable) throw new Error("Fixture demo requires a database with no dispatchable tasks; use a fresh temporary database.");
    const project = sdk.createProject({name: "Orchestrator demo fixture", description: "Disposable, labelled CLI acceptance fixture."});
    const task = sdk.createTask({projectId: project.id, title: "Fixture worker trace", description: "Exercise persisted assignment, progress, artifact and report records.", acceptanceCriteria: ["fixture trace is persisted"], riskTier: 1});
    const worker = sdk.registerWorker({name: "local-demo-fixture-worker"});
    const assignment = sdk.claimTask(worker.id);
    if (!assignment) throw new Error("Fixture task was not assigned");
    sdk.sendWorkerMessage(worker.id, {
      leaseToken: assignment.lease.leaseToken,
      kind: "progress",
      sequence: 1,
      payload: {label: "DEMO FIXTURE", message: "Local fixture worker started"},
      idempotencyKey: `cli-fixture:${assignment.run.id}:progress`
    });
    const artifact = "Orchestrator CLI demo fixture artifact\n";
    sdk.reportTask(worker.id, {
      leaseToken: assignment.lease.leaseToken,
      sequence: 2,
      outcome: "succeeded",
      summary: "Local fixture worker completed; verification and independent review are still required.",
      source: {adapterId: "orchestrator-cli-fixture", sessionId: assignment.run.id},
      evidence: [{kind: "artifact", uri: `fixture://${assignment.run.id}/artifact.txt`, contentHash: createHash("sha256").update(artifact).digest("hex")}]
    });
    const artifactIds = database.prepare("SELECT id FROM evidence_records WHERE run_id=? ORDER BY id").all(assignment.run.id)
      .map((row) => (row as {id: string}).id);
    json(io, {
      fixtureLabel: "DEMO FIXTURE — not real user work",
      projectId: project.id,
      taskId: task.id,
      workerId: worker.id,
      runId: assignment.run.id,
      attemptId: assignment.attempt.id,
      artifactIds,
      note: "Worker success is persisted as verification; this fixture does not claim task acceptance.",
      timeline: trace(database, assignment.run.id)
    });
    return;
  }
  throw new Error("Unknown command. Run `npm run cli -- --db <path> help` for usage.");
}

export async function runCli(args: readonly string[], io: CliIO = defaultIO): Promise<number> {
  let database: Database.Database | undefined;
  try {
    const remaining = [...args];
    let databasePath = process.env.ORCHESTRATOR_DB;
    const dbIndex = remaining.indexOf("--db");
    if (dbIndex >= 0) {
      databasePath = remaining[dbIndex + 1];
      if (!databasePath) throw new Error("Expected a path after --db");
      remaining.splice(dbIndex, 2);
    }
    if (remaining[0] === "help" || remaining.length === 0) {
      io.stdout([
        "Orchestrator headless CLI (SQLite is the source of truth)",
        "  npm run cli -- --db <path> project list|show <id>|create --name <name>",
        "  npm run cli -- --db <path> task list|show <id>|create --project <id> --title <title> --criteria <a|b> [--description <text>] [--risk-tier 1]",
        "  npm run cli -- --db <path> run list|show <id>|trace <id>",
        "  npm run cli -- --db <path> fixture demo",
        "  Set ORCHESTRATOR_DB instead of passing --db."
      ].join("\n") + "\n");
      return 0;
    }
    if (!databasePath?.trim()) throw new Error("Pass --db <path> or set ORCHESTRATOR_DB; database files are not created in the repository by default.");
    database = openDatabase(databasePath);
    await execute(database, createOrchestratorSdk(database), remaining, io);
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    database?.close();
  }
}
