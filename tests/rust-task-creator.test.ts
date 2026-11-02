import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/persistence/database";
import { TaskRepository } from "../src/persistence/task-repository";
import { appendDurableEvent } from "../src/persistence/events";
import { RustCoreClient } from "../src/main/rust-core-client";
import { RustTaskCreator } from "../src/main/rust-task-creator";

const coreExecutable = resolve("target/debug/orchestrator-core.exe");

test("Rust task creator persists one TS-compatible task across retries and never falls back after failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-rust-task-create-"));
  const databasePath = join(directory, "state.sqlite");
  const database = openDatabase(databasePath);
  const input = {
    title: "Rust task create conformance",
    description: "Prove the Rust-owned create path.",
    acceptanceCriteria: ["Task and revision exist", "Audit and outbox are atomic"],
    riskTier: 1 as const,
    idempotencyKey: "rust-task-create-conformance-1"
  };
  let client: RustCoreClient | undefined;
  try {
    const start = async () => RustCoreClient.start(coreExecutable, {
      args: ["serve", "--database", databasePath],
      requiredCapabilities: ["tasks.create"]
    });
    client = await start();
    const creator = new RustTaskCreator(client);
    const created = await creator.create(input);
    assert.equal(created.title, input.title);
    assert.equal(created.status, "intake");

    const typescriptBaseline = new TaskRepository(database).create(input);
    assert.deepEqual(typescriptBaseline, created, "the old TypeScript writer must recognize the Rust command hash and return the existing row");

    const countsBefore = {
      tasks: database.prepare("SELECT count(*) AS n FROM tasks WHERE id=?").get(created.id) as {n: number},
      revisions: database.prepare("SELECT count(*) AS n FROM task_revisions WHERE task_id=?").get(created.id) as {n: number},
      events: database.prepare("SELECT count(*) AS n FROM audit_events WHERE correlation_json=?").get(JSON.stringify({taskId: created.id})) as {n: number},
      outbox: database.prepare("SELECT count(*) AS n FROM outbox WHERE id IN (SELECT id FROM audit_events WHERE correlation_json=?)").get(JSON.stringify({taskId: created.id})) as {n: number}
    };
    assert.deepEqual(countsBefore, {tasks: {n: 1}, revisions: {n: 1}, events: {n: 2}, outbox: {n: 2}});
    const taskEvents = database.prepare("SELECT event_type, payload, previous_hash, event_hash, correlation_json, idempotency_key, created_at FROM audit_events WHERE correlation_json=? ORDER BY rowid").all(JSON.stringify({taskId: created.id})) as Array<{
      event_type: string;
      payload: string;
      previous_hash: string | null;
      event_hash: string;
      correlation_json: string;
      idempotency_key: string | null;
      created_at: string;
    }>;
    for (const event of taskEvents) {
      appendDurableEvent(database, event.event_type, JSON.parse(event.payload) as unknown, event.created_at, {
        correlation: JSON.parse(event.correlation_json) as {taskId: string},
        idempotencyKey: event.idempotency_key ?? undefined
      });
      const expectedHash = createHash("sha256")
        .update(`${event.previous_hash ?? ""}${event.event_type}${event.payload}${event.correlation_json}${event.idempotency_key ?? ""}${event.created_at}`)
        .digest("hex");
      assert.equal(event.event_hash, expectedHash);
    }
    const revision = database.prepare("SELECT snapshot_json, content_hash FROM task_revisions WHERE task_id=?").get(created.id) as {snapshot_json: string; content_hash: string};
    const expectedSnapshot = {
      taskId: created.id,
      projectId: created.projectId,
      parentTaskId: created.parentTaskId,
      title: created.title,
      description: created.description,
      acceptanceCriteria: created.acceptanceCriteria,
      riskTier: created.riskTier,
      skillIds: created.skillIds,
      mcpServerIds: created.mcpServerIds,
      pluginIds: created.pluginIds,
      tokenBudget: created.tokenBudget
    };
    assert.equal(revision.snapshot_json, JSON.stringify(expectedSnapshot));
    assert.equal(revision.content_hash, createHash("sha256").update(revision.snapshot_json).digest("hex"));

    await client.close();
    client = await start();
    const afterRestart = await new RustTaskCreator(client).create(input);
    assert.deepEqual(afterRestart, created, "persistent idempotency must survive Rust restart");

    await assert.rejects(
      new RustTaskCreator(client).create({...input, title: "Changed payload"}),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "IDEMPOTENCY_CONFLICT"
    );

    database.exec("CREATE TRIGGER reject_task_revision_event BEFORE INSERT ON audit_events WHEN NEW.event_type = 'task.revision.created' BEGIN SELECT RAISE(ABORT, 'injected rollback'); END");
    await assert.rejects(
      new RustTaskCreator(client).create({...input, title: "Atomic rollback", idempotencyKey: "rust-task-create-rollback-1"}),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "DATABASE_WRITE_FAILED"
    );
    assert.equal(database.prepare("SELECT count(*) AS n FROM tasks WHERE title='Atomic rollback'").get() &&
      (database.prepare("SELECT count(*) AS n FROM tasks WHERE title='Atomic rollback'").get() as {n: number}).n, 0);
    assert.equal((database.prepare("SELECT count(*) AS n FROM task_commands WHERE idempotency_key='rust-task-create-rollback-1'").get() as {n: number}).n, 0);
  } finally {
    await client?.close().catch(() => undefined);
    database.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
