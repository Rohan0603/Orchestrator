import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDispatchRecord, validateProgressEvent } from "../src/dispatch/dispatch-contract";
import { DispatchRepository } from "../src/persistence/dispatch-repository";
import { openDatabase, PersistenceError } from "../src/persistence/database";
import { applyMigrations } from "../src/persistence/migrations";
import { PolicyRepository } from "../src/persistence/policy-repository";
import { TaskRepository } from "../src/persistence/task-repository";
import { createApprovalRequest, evaluatePolicy } from "../src/policy/policy";

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
    assert.equal(scalar<{ version: number }>(database, "SELECT version FROM schema_version").version, 3);
    assert.doesNotThrow(() => applyMigrations(database));
    assert.equal(scalar<{ version: number }>(database, "SELECT version FROM schema_version").version, 3);
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
      completenessNote: null
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
