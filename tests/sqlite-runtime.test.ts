import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDispatchRecord, validateProgressEvent } from "../src/dispatch/dispatch-contract";
import { DispatchRepository } from "../src/persistence/dispatch-repository";
import { backupDatabase } from "../src/persistence/backup";
import { openDatabase, PersistenceError } from "../src/persistence/database";
import { applyMigrations } from "../src/persistence/migrations";
import { PolicyRepository } from "../src/persistence/policy-repository";
import { RunRepository } from "../src/persistence/run-repository";
import { TaskRepository } from "../src/persistence/task-repository";
import { createApprovalRequest, evaluatePolicy } from "../src/policy/policy";
import { reconcileUnresolvedOwnership } from "../src/recovery/reconcile-ownership";

function withDatabase<T>(run: (database: Database.Database) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-sqlite-"));
  const path = join(directory, "test.db");
  const database = openDatabase(path);
  try {
    return run(database);
  } finally {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seedRun(database: Database.Database, taskId: string) {
  const runId = "run-1";
  const attemptId = "attempt-1";
  database
    .prepare(
      `INSERT INTO runs (id, task_id, state, route_id, recovery_state, created_at)
       VALUES (?, ?, 'awaiting_approval', ?, 'none', ?)`
    )
    .run(runId, taskId, "local-opencode", "2026-01-01T00:00:00.000Z");
  database
    .prepare(
      `INSERT INTO attempts (id, run_id, outcome, worker_report, created_at)
       VALUES (?, ?, 'pending', NULL, ?)`
    )
    .run(attemptId, runId, "2026-01-01T00:00:00.000Z");
  return { runId, attemptId };
}

const action = {
  operation: "run-worker",
  context: {
    operation: "run-worker",
    target: "worktree",
    arguments: ["--safe"],
    payload: null
  },
  riskTier: 2 as const,
  prohibited: false,
  capabilityVerified: true,
  evidenceComplete: true,
  prerequisitesResolved: true
};

const route = {
  routeId: "local-opencode",
  provider: { state: "known" as const, name: "provider" },
  model: { state: "known" as const, name: "model" },
  reportedBy: "adapter" as const
};

function scalar<T extends Record<string, unknown>>(
  database: Database.Database,
  sql: string,
  ...parameters: readonly unknown[]
): T {
  return database.prepare(sql).get(...parameters) as T;
}

test("real SQLite creates schema, enables foreign keys, and reruns migrations", () => {
  withDatabase((database) => {
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(scalar<{ version: number }>(database, "SELECT version FROM schema_version").version, 9);
    assert.doesNotThrow(() => applyMigrations(database));
    assert.equal(scalar<{ version: number }>(database, "SELECT version FROM schema_version").version, 9);
    for (const table of ["tasks", "approvals", "policy_decisions", "dispatch_intents", "evidence_records"]) {
      assert.ok(
        database.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
        ).get(table)
      );
    }
  });
});

test("real SQLite upgrades a schema-one fixture and rolls back failed migration", () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-migration-"));
  const path = join(directory, "upgrade.db");
  const database = new Database(path);
  try {
    database.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (1);
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        context_json TEXT NOT NULL DEFAULT '{}',
        policy_version TEXT NOT NULL DEFAULT 'policy-v1'
      );
    `);
    assert.throws(() => applyMigrations(database), /duplicate column name: context_json/);
    assert.equal(scalar<{ version: number }>(database, "SELECT version FROM schema_version").version, 1);
    assert.equal(
      database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policy_decisions'"
      ).get(),
      undefined
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real SQLite transaction rollback leaves no partial row", () => {
  withDatabase((database) => {
    assert.throws(() => {
      database.transaction(() => {
        database.prepare(
          "INSERT INTO tasks (id, title, description, acceptance_criteria, risk_tier, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run("rollback-task", "title", "description", "[]", 1, "intake", "2026-01-01T00:00:00.000Z");
        throw new Error("deliberate rollback");
      })();
    }, /deliberate rollback/);
    assert.equal(database.prepare("SELECT 1 FROM tasks WHERE id = ?").get("rollback-task"), undefined);
  });
});

test("SQLite backup restores schema and durable task state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-backup-"));
  const sourcePath = join(directory, "source.db");
  const backupPath = join(directory, "backup.db");
  const source = openDatabase(sourcePath);
  try {
    const task = new TaskRepository(source).create({
      title: "Backup task",
      description: "Restore this task",
      acceptanceCriteria: ["restored"],
      riskTier: 1
    });
    await backupDatabase(source, backupPath);
    await assert.rejects(
      () => backupDatabase(source, backupPath),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.message === "Database backup destination already exists"
    );
    const restored = openDatabase(backupPath);
    try {
      assert.equal(new TaskRepository(restored).list()[0].id, task.id);
      assert.equal(scalar<{ version: number }>(restored, "SELECT version FROM schema_version").version, 9);
      assert.equal(restored.pragma("foreign_keys", { simple: true }), 1);
    } finally {
      restored.close();
    }
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repositories persist task, approval, dispatch, progress, and evidence state", () => {
  withDatabase((database) => {
    const tasks = new TaskRepository(database);
    const task = tasks.create({
      title: "Persist task",
      description: "Persist task description",
      acceptanceCriteria: ["check result"],
      riskTier: 2
    });
    assert.equal(tasks.list()[0].id, task.id);
    const { runId, attemptId } = seedRun(database, task.id);

    const policy = evaluatePolicy(action);
    const policies = new PolicyRepository(database);
    policies.recordDecision(policy);
    const approval = policies.createApproval(
      createApprovalRequest(runId, action, "policy-v1", "2099-01-01T00:00:00.000Z")
    );
    assert.equal(policies.consumeApproval(approval.id, action, "policy-v1").consumedAt !== null, true);
    assert.throws(
      () => policies.consumeApproval(approval.id, action, "policy-v1"),
      (error: unknown) => error instanceof PersistenceError
    );

    const authorization = {
      runId,
      attemptId,
      actionDigest: policy.actionDigest,
      approvalId: approval.id,
      policyVersion: "policy-v1"
    };
    const intent = {
      id: "intent-1",
      dispatchId: "dispatch-1",
      idempotencyKey: "idempotency-1",
      correlation: { dispatchId: "dispatch-1", runId, attemptId },
      taskId: task.id,
      runId,
      attemptId,
      route,
      authorization,
      deadlineAt: "2099-01-01T00:00:00.000Z",
      state: "persisted" as const,
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    const dispatches = new DispatchRepository(database);
    dispatches.persistIntent(createDispatchRecord(intent, task, authorization));
    assert.throws(
      () => dispatches.persistIntent(createDispatchRecord(intent, task, authorization)),
      (error: unknown) => error instanceof PersistenceError
    );
    const cursor = dispatches.createCursor(intent.correlation);
    const event = {
      eventId: "event-1",
      correlation: intent.correlation,
      sequence: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
      kind: "message" as const,
      message: "started",
      evidence: []
    };
    dispatches.recordProgress(event, validateProgressEvent(event, cursor));
    dispatches.recordEvidence({
      id: "evidence-1",
      kind: "check",
      correlation: intent.correlation,
      eventId: event.eventId,
      provenance: "orchestrator_verified",
      uri: "file:///check.txt",
      contentHash: null,
      capturedAt: event.occurredAt,
      status: "present",
      independentlyVerified: true,
      completenessNote: null,
      criterionIds: []
    });
    assert.equal(
      scalar<{ count: number }>(database, "SELECT count(*) AS count FROM progress_events").count,
      1
    );
    assert.equal(
      scalar<{ count: number }>(database, "SELECT count(*) AS count FROM evidence_records").count,
      1
    );
  });
});

test("run creation persists intent and restart reconciliation fails closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-recovery-"));
  const path = join(directory, "recovery.db");
  let database = openDatabase(path);
  try {
    const task = new TaskRepository(database).create({
      title: "Recover task",
      description: "Recover interrupted run",
      acceptanceCriteria: ["reconcile safely"],
      riskTier: 1
    });
    const runs = new RunRepository(database);
    const created = runs.createRun(task.id, "local-opencode", "2026-01-01T00:00:00.000Z");
    assert.deepEqual(runs.listForTask(task.id), [{
      run: created.run,
      attempt: created.attempt
    }]);
    database
      .prepare("UPDATE runs SET state = 'running' WHERE id = ?")
      .run(created.run.id);
    database.close();

    database = openDatabase(path);
    const reconciled = new RunRepository(database).reconcileInterruptedRuns(
      "2026-01-01T00:01:00.000Z"
    );
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].state, "recovery_required");
    assert.equal(reconciled[0].recoveryState, "recovery_required");
    assert.equal(
      scalar<{ outcome: string }>(
        database,
        "SELECT outcome FROM attempts WHERE id = ?",
        created.attempt.id
      ).outcome,
      "disconnected"
    );
    assert.equal(
      scalar<{ state: string }>(
        database,
        "SELECT state FROM recovery WHERE run_id = ?",
        created.run.id
      ).state,
      "recovery_required"
    );
    assert.equal(
      new RunRepository(database).reconcileInterruptedRuns("2026-01-01T00:02:00.000Z").length,
      0
    );
    assert.equal(
      scalar<{ count: number }>(
        database,
        "SELECT count(*) AS count FROM audit_events WHERE event_type = 'run.recovery_required'"
      ).count,
      1
    );
  } finally {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startup reconciliation recovers stranded created, ready, and unresolved ownership runs", () => {
  withDatabase((database) => {
    const tasks = new TaskRepository(database);
    const runs = new RunRepository(database);
    const createdTask = tasks.create({
      title: "Created recovery",
      description: "Recover created run",
      acceptanceCriteria: ["recovery"],
      riskTier: 1
    });
    const readyTask = tasks.create({
      title: "Ready recovery",
      description: "Recover ready run",
      acceptanceCriteria: ["recovery"],
      riskTier: 1
    });
    const ownedTask = tasks.create({
      title: "Ownership recovery",
      description: "Recover unresolved owner",
      acceptanceCriteria: ["recovery"],
      riskTier: 1
    });
    const created = runs.createRun(createdTask.id, "fixture");
    const ready = runs.createRun(readyTask.id, "fixture");
    runs.transition(ready.run.id, "ready", "none");
    const owned = runs.createRun(ownedTask.id, "fixture");
    runs.transition(owned.run.id, "ready", "none");
    runs.transition(owned.run.id, "running", "none");
    runs.recordOwnership({
      runId: owned.run.id,
      attemptId: owned.attempt.id,
      helperPid: 1234,
      helperCreationTime: "creation",
      workerPid: 5678,
      workerCreationTime: "worker-creation",
      helperExecutable: "helper.exe",
      protocolVersion: "orchestrator-job-v1",
      nonce: "nonce",
      state: "uncertain",
      lastStatus: "owner_lost",
      cleanupVerified: false,
      uncertaintyReason: "helper exited",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    const reconciled = runs.reconcileInterruptedRuns("2026-01-01T00:01:00.000Z");
    assert.deepEqual(
      reconciled.map((run) => run.id).sort(),
      [created.run.id, ready.run.id, owned.run.id].sort()
    );
    for (const run of reconciled) assert.equal(run.state, "recovery_required");
    assert.equal(
      scalar<{ count: number }>(
        database,
        "SELECT count(*) AS count FROM attempts WHERE outcome = 'disconnected'"
      ).count,
      3
    );
    assert.equal(runs.reconcileInterruptedRuns("2026-01-01T00:02:00.000Z").length, 0);
    runs.recordOwnership({
      ...runs.ownershipForRun(owned.run.id)!,
      state: "exited_observed",
      lastStatus: "restart_observed_exited",
      cleanupVerified: false,
      uncertaintyReason: null,
      updatedAt: "2026-01-01T00:02:30.000Z"
    });
    assert.equal(runs.listUnresolvedOwnership().length, 0);
    runs.recordOwnership({
      ...runs.ownershipForRun(owned.run.id)!,
      state: "cleanup_verified",
      lastStatus: "restart_reconciled",
      cleanupVerified: true,
      uncertaintyReason: null,
      updatedAt: "2026-01-01T00:03:00.000Z"
    });
    runs.recordRecoveryOutcome(
      owned.run.id,
      "reconciled",
      "Matching identity and cleanup verified",
      "2026-01-01T00:03:00.000Z"
    );
    runs.recordRecoveryOutcome(
      owned.run.id,
      "reconciled",
      "Repeated reconciliation is idempotent",
      "2026-01-01T00:04:00.000Z"
    );
    assert.equal(runs.listUnresolvedOwnership().length, 0);
    assert.deepEqual(
      database.prepare("SELECT state FROM recovery WHERE run_id = ?").get(owned.run.id),
      { state: "reconciled" }
    );
  });
});

test("startup ownership reconciliation records missing-helper uncertainty idempotently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-recovery-"));
  const database = openDatabase(join(directory, "recovery.db"));
  try {
    const task = new TaskRepository(database).create({
      title: "Recovery test",
      description: "Exercise startup reconciliation failure",
      acceptanceCriteria: ["uncertainty"],
      riskTier: 1
    });
    const created = new RunRepository(database).createRun(task.id, "recovery-test");
    const runs = new RunRepository(database);
    runs.recordOwnership({
      runId: created.run.id,
      attemptId: created.attempt.id,
      helperPid: null,
      helperCreationTime: null,
      workerPid: 42,
      workerCreationTime: "stale",
      helperExecutable: "missing-helper.exe",
      protocolVersion: "orchestrator-job-v1",
      nonce: "recovery-test-nonce",
      state: "uncertain",
      lastStatus: "owner_lost",
      cleanupVerified: false,
      uncertaintyReason: "helper lost",
      updatedAt: new Date().toISOString()
    });
    runs.transition(created.run.id, "recovery_required", "recovery_required");
    await reconcileUnresolvedOwnership(runs, join(process.cwd(), "missing-helper.exe"));
    const first = runs.ownershipForRun(created.run.id);
    assert.equal(first?.cleanupVerified, false);
    assert.match(first?.lastStatus ?? "", /restart_reconciliation_unverified/);
    assert.deepEqual(
      database.prepare("SELECT state FROM recovery WHERE run_id = ?").get(created.run.id),
      { state: "recovery_required" }
    );
    await reconcileUnresolvedOwnership(runs, join(process.cwd(), "missing-helper.exe"));
    assert.equal(runs.listUnresolvedOwnership().length, 1);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("run creation rolls back when task foreign key is invalid", () => {
  withDatabase((database) => {
    assert.throws(
      () => new RunRepository(database).createRun("missing-task", null),
      (error: unknown) => error instanceof PersistenceError
    );
    assert.equal(
      scalar<{ count: number }>(database, "SELECT count(*) AS count FROM runs").count,
      0
    );
    assert.equal(
      scalar<{ count: number }>(database, "SELECT count(*) AS count FROM attempts").count,
      0
    );
  });
});

test("run repository enforces one active run and valid state transitions", () => {
  withDatabase((database) => {
    const task = new TaskRepository(database).create({
      title: "Single active run",
      description: "Prevent concurrent runs",
      acceptanceCriteria: ["one active run"],
      riskTier: 1
    });
    const runs = new RunRepository(database);
    const created = runs.createRun(task.id, null);
    assert.throws(
      () => runs.createRun(task.id, null),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.message === "Run creation failed"
    );
    assert.throws(
      () => runs.transition(created.run.id, "accepted", "none"),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.cause instanceof Error &&
        error.cause.message.includes("Invalid run transition")
    );
    runs.transition(created.run.id, "ready", "none");
    assert.equal(
      scalar<{ state: string }>(database, "SELECT state FROM runs WHERE id = ?", created.run.id).state,
      "ready"
    );
  });
});

test("repository reports explicit persistence errors after database close", () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-error-"));
  const database = openDatabase(join(directory, "test.db"));
  const tasks = new TaskRepository(database);
  database.close();
  try {
    assert.throws(() => tasks.list(), (error: unknown) => error instanceof PersistenceError);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
