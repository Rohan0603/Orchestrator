import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { EventRepository } from "../src/persistence/events";
import { applyMigrations } from "../src/persistence/migrations";
import { openDatabase } from "../src/persistence/database";
import { TaskRepository } from "../src/persistence/task-repository";
import { MessageDeliveryRepository, DeliveryFailure } from "../src/persistence/message-delivery-repository";
import { InternalMessageDispatcher } from "../src/dispatch/internal-message-dispatcher";
import { AGENT_MESSAGE_SCHEMA_VERSION, type ReviewRequestedMessage, type TaskProgressMessage } from "../src/shared/agent-message";

const NOW = "2026-11-01T00:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
function seed(db: Database.Database, suffix = "1"): ReviewRequestedMessage {
  const task = new TaskRepository(db).create({ title: "Message task", description: "", riskTier: 1, acceptanceCriteria: ["review"] });
  const runId = `run-${suffix}`, attemptId = `attempt-${suffix}`;
  db.prepare("INSERT INTO runs (id, task_id, state, recovery_state, created_at) VALUES (?, ?, 'verification', 'none', ?)").run(runId, task.id, NOW);
  db.prepare("INSERT INTO attempts (id, run_id, outcome, created_at) VALUES (?, ?, 'succeeded', ?)").run(attemptId, runId, NOW);
  db.prepare("INSERT INTO worker_messages (id,run_id,attempt_id,direction,kind,sequence,payload_json,created_at) VALUES (?, ?, ?, 'worker_to_orchestrator','report',1,'{}',?)").run(`report-${suffix}`, runId, attemptId, NOW);
  return { schemaVersion: AGENT_MESSAGE_SCHEMA_VERSION, messageId: `message-${suffix}`, messageType: "review.requested", occurredAt: NOW,
    taskId: task.id, runId, attemptId, expectedRevision: 0, correlationId: runId, causationId: `report-${suffix}`,
    sender: { agentId: "orchestrator", role: "orchestrator" }, recipient: { agentId: "review-intake" },
    authorization: { principalId: "orchestrator", delegationChain: [], capabilityGrantId: null },
    payload: { reportMessageId: `report-${suffix}`, evidenceIds: [] } };
}
function seedProgress(db: Database.Database, suffix = "progress"): TaskProgressMessage {
  const task = new TaskRepository(db).create({ title: "Progress message", description: "", riskTier: 1, acceptanceCriteria: ["finish"] });
  const runId = `run-${suffix}`, attemptId = `attempt-${suffix}`;
  db.prepare("INSERT INTO runs (id, task_id, state, recovery_state, created_at) VALUES (?, ?, 'running', 'none', ?)").run(runId, task.id, NOW);
  db.prepare("INSERT INTO attempts (id, run_id, outcome, created_at) VALUES (?, ?, 'pending', ?)").run(attemptId, runId, NOW);
  return { schemaVersion: AGENT_MESSAGE_SCHEMA_VERSION, messageId: `message-${suffix}`, messageType: "task.progress", occurredAt: NOW,
    taskId: task.id, runId, attemptId, expectedRevision: 0, correlationId: runId, causationId: `worker-progress-${suffix}`,
    sender: { agentId: "orchestrator", role: "orchestrator" }, recipient: { agentId: "progress-consumer" },
    authorization: { principalId: "orchestrator", delegationChain: [], capabilityGrantId: null }, payload: { summary: "Progress recorded" } };
}
const count = (db: Database.Database, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n;
function effect(db: Database.Database) { db.prepare("INSERT INTO effects DEFAULT VALUES").run(); }
function fixture() {
  const db = openDatabase(":memory:"); db.exec("CREATE TABLE effects (id INTEGER PRIMARY KEY)");
  return { db, repo: new MessageDeliveryRepository(db) };
}

test("consumer effect and inbox rollback together and remain processable", () => {
  const {db, repo} = fixture(); try {
    repo.enqueue(seed(db)); const claim = repo.claim("dispatcher", NOW)!;
    assert.throws(() => repo.consume(claim, NOW, () => { effect(db); throw new Error("injected after effect"); }));
    assert.equal(count(db, "effects"), 0); assert.equal(count(db, "processed_messages"), 0);
    repo.consume(claim, NOW, () => effect(db));
    repo.consume(claim, NOW, () => effect(db));
    assert.equal(count(db, "effects"), 1); assert.equal(count(db, "processed_messages"), 1);
    repo.complete(claim, NOW);
  } finally { db.close(); }
});

test("acknowledgement insertion failure rolls back the domain effect", () => {
  const {db, repo} = fixture(); try {
    repo.enqueue(seed(db)); const claim = repo.claim("dispatcher", NOW)!;
    db.exec("CREATE TRIGGER reject_ack AFTER INSERT ON processed_messages BEGIN SELECT RAISE(ABORT, 'injected ack rollback'); END");
    assert.throws(() => repo.consume(claim, NOW, () => effect(db)), /injected/);
    assert.equal(count(db, "effects"), 0); assert.equal(count(db, "processed_messages"), 0);
    db.exec("DROP TRIGGER reject_ack"); repo.consume(claim, NOW, () => effect(db)); assert.equal(count(db, "effects"), 1);
  } finally { db.close(); }
});

test("restart before delivery and after consumer commit never repeats an effect", () => {
  const directory = mkdtempSync(join(tmpdir(), "message-restart-")), path = join(directory, "state.db");
  let db = openDatabase(path);
  try {
    db.exec("CREATE TABLE effects (id INTEGER PRIMARY KEY)"); new MessageDeliveryRepository(db).enqueue(seed(db)); db.close();
    db = openDatabase(path); let repo = new MessageDeliveryRepository(db);
    const first = repo.claim("before-crash", NOW, 1000)!; repo.consume(first, NOW, () => effect(db)); db.close();
    db = openDatabase(path); repo = new MessageDeliveryRepository(db);
    // Missing dispatcher completion is repaired from the committed inbox on restart.
    assert.equal(repo.claim("after-crash", later(2)), null);
    assert.equal(count(db, "effects"), 1);
    assert.equal((db.prepare("SELECT status FROM message_deliveries").get() as {status: string}).status, "acknowledged");
  } finally { db.close(); rmSync(directory, {recursive: true, force: true}); }
});

test("claims fence expired owners and preserve per-run ordering", () => {
  const {db, repo} = fixture(); try {
    const msg = seed(db); repo.enqueue(msg); repo.enqueue({...msg, messageId: "message-next"});
    const first = repo.claim("first", NOW, 1000)!;
    assert.equal(repo.claim("second", NOW), null);
    const replacement = repo.claim("second", later(2))!;
    assert.equal(replacement.message_id, first.message_id);
    assert.throws(() => repo.consume(first, later(2), () => effect(db)), /claim/i);
    assert.throws(() => repo.complete(first, later(2)), /claim/i);
    repo.consume(replacement, later(2), () => effect(db)); repo.complete(replacement, later(2));
    assert.equal(repo.claim("second", later(2))?.message_id, "message-next");
  } finally { db.close(); }
});

test("deduplication is consumer specific and altered identity conflicts", () => {
  const {db, repo} = fixture(); try {
    const msg = seed(db); repo.enqueue(msg);
    assert.throws(() => repo.enqueue({...msg, payload: {reportMessageId: "other", evidenceIds: []}}), /conflict/i);
    const first = repo.claim("owner", NOW)!; repo.consume(first, NOW, () => effect(db)); repo.complete(first, NOW);
    repo.enqueue(msg, "other-consumer");
    const second = repo.claim("owner", NOW)!; repo.consume(second, NOW, () => effect(db)); repo.complete(second, NOW);
    assert.equal(count(db, "effects"), 2);
  } finally { db.close(); }
});

test("stale state, stale attempts, wrong relationships, and denied authority fail closed", () => {
  for (const mode of ["revision", "attempt", "relationship", "policy"] as const) {
    const {db, repo} = fixture(); try {
      let msg = seed(db);
      if (mode === "policy") msg = {...msg, authorization: {...msg.authorization, principalId: "worker"}};
      if (mode === "relationship") msg = {...msg, taskId: new TaskRepository(db).create({title: "other", description: "", riskTier: 1, acceptanceCriteria: ["x"]}).id};
      repo.enqueue(msg); const claim = repo.claim("owner", NOW)!;
      if (mode === "revision") { db.prepare("UPDATE runs SET state='review' WHERE id=?").run(msg.runId); db.prepare("UPDATE runs SET state='verification' WHERE id=?").run(msg.runId); }
      if (mode === "attempt") db.prepare("INSERT INTO attempts (id,run_id,outcome,created_at) VALUES ('newer',?,'pending',?)").run(msg.runId, NOW);
      assert.throws(() => repo.consume(claim, NOW, () => effect(db)), DeliveryFailure);
      assert.equal(count(db, "effects"), 0); assert.equal(count(db, "processed_messages"), 0);
    } finally { db.close(); }
  }
});

test("dispatcher persists bounded backoff and dead letters block required actions", () => {
  const {db, repo} = fixture(); try {
    const msg = seed(db); repo.enqueue(msg);
    const dispatcher = new InternalMessageDispatcher(repo, {"review-intake": () => { throw new DeliveryFailure("transient", "temporarily_unavailable"); }});
    for (const second of [0, 1, 3, 7, 15]) assert.equal(dispatcher.dispatchDue(later(second), 1).length, 1);
    assert.equal(count(db, "message_delivery_attempts"), 5);
    assert.equal(repo.deadLetters()[0]?.status, "dead_letter");
    assert.equal((db.prepare("SELECT state FROM runs WHERE id=?").get(msg.runId) as {state: string}).state, "blocked");
    assert.equal(dispatcher.dispatchDue(later(100), 1).length, 0);
  } finally { db.close(); }
});

test("permanent, policy, conflict and uncertain outcomes never retry", () => {
  for (const classification of ["permanent", "policy", "conflict", "uncertain"] as const) {
    const {db, repo} = fixture(); try {
      const msg = seed(db); repo.enqueue(msg);
      const dispatcher = new InternalMessageDispatcher(repo, {"review-intake": () => { throw new DeliveryFailure(classification, "injected_failure"); }});
      dispatcher.dispatchDue(NOW, 1); dispatcher.dispatchDue(later(100), 1);
      assert.equal(count(db, "message_delivery_attempts"), 1);
      assert.equal(repo.deadLetters().length, 1);
      const row = db.prepare("SELECT state,recovery_state FROM runs WHERE id=?").get(msg.runId) as {state: string; recovery_state: string};
      assert.equal(row.state, classification === "uncertain" ? "inconclusive" : "blocked");
      if (classification === "uncertain") assert.equal(row.recovery_state, "recovery_required");
    } finally { db.close(); }
  }
});

test("uncertain task.progress delivery moves its current running run into recovery", () => {
  const {db, repo} = fixture(); try {
    const msg = seedProgress(db); repo.enqueue(msg);
    const claim = repo.claim("owner", NOW)!;
    repo.fail(claim, NOW, new DeliveryFailure("uncertain", "consumer_outcome_unknown"));
    assert.deepEqual(db.prepare("SELECT state,recovery_state FROM runs WHERE id=?").get(msg.runId), {state: "recovery_required", recovery_state: "recovery_required"});
    assert.deepEqual(db.prepare("SELECT state,reason FROM recovery WHERE run_id=?").get(msg.runId), {state: "recovery_required", reason: "consumer_outcome_unknown"});
    assert.deepEqual(db.prepare("SELECT status FROM tasks WHERE id=?").get(msg.taskId), {status: "blocked"});
    assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE event_type='run.state_changed' AND payload LIKE '%recovery_required%'").get());
  } finally { db.close(); }
});

test("uncertain task.progress from a stale lifecycle revision cannot rewrite the current run", () => {
  const {db, repo} = fixture(); try {
    const msg = seedProgress(db); repo.enqueue(msg);
    const claim = repo.claim("owner", NOW)!;
    db.prepare("UPDATE runs SET lifecycle_revision=1 WHERE id=?").run(msg.runId);
    repo.fail(claim, NOW, new DeliveryFailure("uncertain", "consumer_outcome_unknown"));
    assert.deepEqual(db.prepare("SELECT state,recovery_state,lifecycle_revision FROM runs WHERE id=?").get(msg.runId), {state: "running", recovery_state: "none", lifecycle_revision: 1});
    assert.equal(count(db, "recovery"), 0);
    assert.deepEqual(db.prepare("SELECT status FROM tasks WHERE id=?").get(msg.taskId), {status: "intake"});
  } finally { db.close(); }
});

test("malformed stored messages never reach handlers and batches stay bounded", () => {
  for (const patch of [{schemaVersion: "future"}, {messageType: "unknown"}, {payload: {}}, {payload: {summary: "x".repeat(1024 * 1024)}}]) {
    const {db, repo} = fixture(); try {
      const msg = seed(db); repo.enqueue(msg);
      db.prepare("UPDATE outbox SET payload=? WHERE id=?").run(JSON.stringify({...msg,...patch}), msg.messageId);
      let calls = 0; const dispatcher = new InternalMessageDispatcher(repo, {"review-intake": () => { calls++; }});
      dispatcher.dispatchDue(NOW, 1); assert.equal(calls, 0); assert.equal(repo.deadLetters().length, 1);
    } finally { db.close(); }
  }
  const {db, repo} = fixture(); try {
    repo.enqueue(seed(db, "a")); repo.enqueue(seed(db, "b"));
    const dispatcher = new InternalMessageDispatcher(repo, {"review-intake": () => effect(db)});
    assert.equal(dispatcher.dispatchDue(NOW, 1).length, 1); assert.equal(count(db, "effects"), 1);
    assert.equal(dispatcher.dispatchDue(NOW, 1).length, 1);
  } finally { db.close(); }
});

test("terminal failure from an old attempt cannot block a newer attempt", () => {
  const {db, repo} = fixture(); try {
    const msg = seed(db); repo.enqueue(msg); const claim = repo.claim("owner", NOW)!;
    db.prepare("INSERT INTO attempts (id,run_id,outcome,created_at) VALUES ('newer',?,'pending',?)").run(msg.runId, NOW);
    repo.fail(claim, NOW, new DeliveryFailure("permanent", "unavailable"));
    assert.equal((db.prepare("SELECT state FROM runs WHERE id=?").get(msg.runId) as {state: string}).state, "verification");
  } finally { db.close(); }
});


test("generic audit publisher cannot claim semantic consumer acknowledgement", () => {
  const {db, repo} = fixture(); try {
    const msg = seed(db); repo.enqueue(msg);
    const events = new EventRepository(db);
    assert.equal(events.pending(100, NOW).some((row) => row.id === msg.messageId), false);
    assert.throws(() => events.markPublished(msg.messageId, NOW), /semantic|consumer/i);
  } finally { db.close(); }
});

test("declared asynchronous consumers are rejected before executing", () => {
  const {db, repo} = fixture(); try {
    repo.enqueue(seed(db)); const claim = repo.claim("owner", NOW)!;
    let calls = 0;
    assert.throws(() => repo.consume(claim, NOW, async () => { calls++; }), /async/);
    assert.equal(calls, 0); assert.equal(count(db, "processed_messages"), 0);
  } finally { db.close(); }
});

test("recoverable SQLite busy errors retry only after consumer rollback", () => {
  const {db, repo} = fixture(); try {
    repo.enqueue(seed(db));
    const dispatcher = new InternalMessageDispatcher(repo, {"review-intake": () => {
      effect(db); throw Object.assign(new Error("sensitive SQL omitted"), {code: "SQLITE_BUSY"});
    }});
    assert.deepEqual(dispatcher.dispatchDue(NOW, 1), ["transient"]);
    assert.equal(count(db, "effects"), 0); assert.equal(repo.deadLetters().length, 0);
  } finally { db.close(); }
});

test("two connections fence claims and retain retry budgets across reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "message-claims-")), path = join(directory, "state.db");
  let first = openDatabase(path); let second: Database.Database | undefined;
  try {
    const msg = seed(first); new MessageDeliveryRepository(first).enqueue(msg);
    second = openDatabase(path); const repo = new MessageDeliveryRepository(first);
    const claim = repo.claim("first", NOW)!;
    assert.equal(new MessageDeliveryRepository(second).claim("second", NOW), null);
    repo.fail(claim, NOW, new DeliveryFailure("transient", "busy")); first.close();
    first = openDatabase(path); const reopened = new MessageDeliveryRepository(first);
    assert.equal(reopened.claim("reopened", NOW), null);
    assert.equal(reopened.claim("reopened", later(1))?.attempt_count, 2);
  } finally { if (first.open) first.close(); second?.close(); rmSync(directory, {recursive: true, force: true}); }
});

test("forward migration preserves legacy state and generic outbox rows", () => {
  const {db} = fixture(); try {
    const msg = seed(db); new EventRepository(db).append("legacy.fact", {taskId: msg.taskId}, NOW);
    const originalCount = count(db, "outbox");
    // Restore the exact schema-11 shape on this disposable fixture, then migrate forward.
    db.exec(`DROP TABLE task_commands; DROP TABLE task_dependencies; DROP TABLE task_revisions;
      DROP TABLE review_requests; DROP TABLE processed_messages; DROP TABLE message_delivery_attempts;
      DROP TABLE message_deliveries; DROP TRIGGER runs_lifecycle_revision; ALTER TABLE runs DROP COLUMN lifecycle_revision;
      UPDATE schema_version SET version=11;`);
    applyMigrations(db);
    assert.deepEqual(db.prepare("SELECT version FROM schema_version").get(), {version: 13});
    assert.equal(count(db, "outbox"), originalCount); assert.equal(count(db, "message_deliveries"), 0);
    assert.ok(new EventRepository(db).pending(100, NOW).some((row) => row.eventType === "legacy.fact"));
  } finally { db.close(); }
});

test("restart reconciliation and exhausted claims do not stall unrelated pending work", () => {
  for (const committed of [true, false]) {
    const {db, repo} = fixture(); try {
      repo.enqueue(seed(db, "a")); repo.enqueue(seed(db, "b"));
      const claim = repo.claim("before-restart", NOW, 1000)!;
      if (committed) repo.consume(claim, NOW, () => effect(db));
      else db.prepare("UPDATE message_deliveries SET attempt_count=5 WHERE message_id=?").run(claim.message_id);
      const dispatcher = new InternalMessageDispatcher(repo, {"review-intake": () => effect(db)}, "after-restart");
      assert.deepEqual(dispatcher.dispatchDue(later(2), 2), [committed ? "duplicate" : "dead_letter", "processed"]);
      assert.equal(count(db, "effects"), committed ? 2 : 1);
    } finally { db.close(); }
  }
});

test("required-action failure and owner state roll back together on persistence failure", () => {
  const {db, repo} = fixture(); try {
    const msg = seed(db); repo.enqueue(msg); const claim = repo.claim("owner", NOW)!;
    db.exec("CREATE TRIGGER reject_failure BEFORE INSERT ON audit_events WHEN NEW.event_type='internal.message.delivery_failed' BEGIN SELECT RAISE(ABORT,'injected terminal rollback'); END");
    assert.throws(() => repo.fail(claim, NOW, new DeliveryFailure("permanent", "invalid_destination")), /injected/);
    assert.deepEqual(db.prepare("SELECT state FROM runs WHERE id=?").get(msg.runId), {state: "verification"});
    assert.deepEqual(db.prepare("SELECT status FROM message_deliveries").get(), {status: "claimed"});
    assert.equal(repo.deadLetters().length, 0);
    db.exec("DROP TRIGGER reject_failure"); repo.fail(claim, NOW, new DeliveryFailure("permanent", "invalid_destination"));
    assert.deepEqual(db.prepare("SELECT state FROM runs WHERE id=?").get(msg.runId), {state: "blocked"});
  } finally { db.close(); }
});

test("transactional lifecycle audit preserves append order when timestamps tie or move backwards", () => {
  const {db} = fixture(); try {
    const events = new EventRepository(db);
    events.append("first.fact", {}, NOW);
    const second = events.append("second.fact", {}, "2026-10-31T23:59:59.000Z");
    const third = events.append("third.fact", {}, NOW);
    assert.equal(third.previousHash, second.eventHash);
  } finally { db.close(); }
});
