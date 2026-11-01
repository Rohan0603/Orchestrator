import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { parseAgentMessage, type AgentMessage } from "../shared/agent-message";
import { appendDurableEvent } from "./events";

export type DeliveryFailureClass = "transient" | "permanent" | "policy" | "conflict" | "uncertain";
export class DeliveryFailure extends Error {
  public constructor(public readonly classification: DeliveryFailureClass, public readonly code: string) {
    super(code); this.name = "DeliveryFailure";
  }
}
export interface DeliveryRecord {
  readonly consumer_id: string;
  readonly message_id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly attempt_id: string;
  readonly expected_revision: number;
  readonly correlation_id: string;
  readonly causation_id: string;
  readonly sequence: number;
  readonly status: string;
  readonly attempt_count: number;
  readonly claim_token: string | null;
  readonly claim_expires_at: string | null;
  readonly payload: string;
  readonly error_class: string | null;
  readonly reason: string | null;
}
export interface DeliveryClaim extends DeliveryRecord {
  readonly claim_token: string;
  readonly claim_expires_at: string;
}
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5;
const hash = (payload: string) => createHash("sha256").update(payload).digest("hex");
function iso(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Canonical UTC time required");
}

/** Database-only consumers: no awaits, remote calls, process launches, or filesystem effects. */
export class MessageDeliveryRepository {
  public constructor(private readonly database: Database.Database, private readonly maxAttempts = DEFAULT_MAX_DELIVERY_ATTEMPTS) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error("Invalid delivery attempt bound");
  }

  public enqueue(input: AgentMessage, consumerId = input.recipient.agentId): void {
    const parsed = parseAgentMessage(input);
    if (!parsed.ok) throw new DeliveryFailure("permanent", parsed.error);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(consumerId)) throw new Error("Invalid consumer id");
    const message = parsed.message, payload = JSON.stringify(message);
    this.database.transaction(() => {
      const existing = this.database.prepare("SELECT event_type,payload FROM outbox WHERE id=?").get(message.messageId) as {event_type: string; payload: string} | undefined;
      if (existing && (existing.event_type !== "internal.message" || existing.payload !== payload)) throw new DeliveryFailure("conflict", "message_identity_conflict");
      if (!existing) this.database.prepare(
        "INSERT INTO outbox (id,event_type,payload,published_at,attempt_count,next_attempt_at,created_at) VALUES (?,'internal.message',?,NULL,0,?,?)"
      ).run(message.messageId, payload, message.occurredAt, message.occurredAt);
      if (this.database.prepare("SELECT 1 FROM message_deliveries WHERE consumer_id=? AND message_id=?").get(consumerId, message.messageId)) return;
      const {sequence} = this.database.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM message_deliveries WHERE consumer_id=? AND run_id=?").get(consumerId, message.runId) as {sequence: number};
      this.database.prepare("UPDATE outbox SET published_at=NULL WHERE id=?").run(message.messageId);
      this.database.prepare(`INSERT INTO message_deliveries
        (message_id,consumer_id,run_id,task_id,attempt_id,expected_revision,correlation_id,causation_id,sequence,status,next_attempt_at)
        VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`).run(message.messageId, consumerId, message.runId, message.taskId, message.attemptId, message.expectedRevision, message.correlationId, message.causationId, sequence, message.occurredAt);
    }).immediate();
  }

  public claim(owner: string, now: string, leaseMs = 30_000): DeliveryClaim | null {
    return this.claimStep(owner, now, leaseMs).claim;
  }

  public claimStep(owner: string, now: string, leaseMs = 30_000): {claim: DeliveryClaim | null; disposition?: string} {
    iso(now);
    if (!owner.trim() || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new Error("Invalid claim options");
    return this.database.transaction(() => {
      // Reconcile only the next eligible record; each dispatch remains bounded.
      const row = this.database.prepare(`SELECT d.*,o.payload FROM message_deliveries d JOIN outbox o ON o.id=d.message_id
        WHERE ((d.status='pending' AND d.next_attempt_at<=?) OR (d.status='claimed' AND d.claim_expires_at<=?))
        AND NOT EXISTS (SELECT 1 FROM message_deliveries earlier WHERE earlier.consumer_id=d.consumer_id AND earlier.run_id=d.run_id
          AND earlier.sequence<d.sequence AND earlier.status<>'acknowledged')
        ORDER BY d.next_attempt_at,d.run_id,d.sequence,d.message_id LIMIT 1`).get(now, now) as DeliveryClaim | undefined;
      if (!row) return {claim: null};
      if (row.status === "claimed") this.database.prepare(`UPDATE message_delivery_attempts SET finished_at=?,disposition='ownership_expired'
        WHERE claim_token=? AND finished_at IS NULL`).run(now, row.claim_token);
      const token = randomUUID();
      this.database.prepare(`UPDATE message_deliveries SET status='claimed',claimed_by=?,claimed_at=?,claim_token=?,claim_expires_at=?
        WHERE consumer_id=? AND message_id=?`).run(owner, now, token, new Date(Date.parse(now) + leaseMs).toISOString(), row.consumer_id, row.message_id);
      const claim = {...row, status: "claimed", claim_token: token, claim_expires_at: new Date(Date.parse(now) + leaseMs).toISOString()};
      const processed = this.processed(claim);
      if (processed) {
        if (processed.content_hash !== hash(row.payload)) this.terminal(claim, now, new DeliveryFailure("conflict", "processed_content_conflict"));
        else this.acknowledge(claim, now);
        return {claim: null, disposition: processed.content_hash === hash(row.payload) ? "duplicate" : "conflict"};
      }
      if (row.attempt_count >= this.maxAttempts) {
        this.terminal(claim, now, new DeliveryFailure("permanent", "delivery_attempts_exhausted")); return {claim: null, disposition: "dead_letter"};
      }
      this.database.prepare("UPDATE message_deliveries SET attempt_count=attempt_count+1 WHERE consumer_id=? AND message_id=?").run(row.consumer_id, row.message_id);
      this.database.prepare(`INSERT INTO message_delivery_attempts
        (consumer_id,message_id,attempt_number,claim_token,claimed_by,started_at) VALUES (?,?,?,?,?,?)`
      ).run(row.consumer_id, row.message_id, row.attempt_count + 1, token, owner, now);
      return {claim: {...claim, attempt_count: row.attempt_count + 1}};
    }).immediate();
  }

  public consume(claim: DeliveryClaim, now: string, handler: (message: AgentMessage) => void): "processed" | "duplicate" {
    // Reject declared async callbacks before invoking them; other thenables roll back below.
    if (handler.constructor.name === "AsyncFunction") throw new DeliveryFailure("permanent", "async_consumer_not_allowed");
    return this.database.transaction(() => {
      this.assertClaim(claim, now);
      const stored = this.database.prepare("SELECT payload,event_type FROM outbox WHERE id=?").get(claim.message_id) as {payload: string; event_type: string};
      const processed = this.processed(claim);
      if (processed) {
        if (processed.content_hash !== hash(stored.payload)) throw new DeliveryFailure("conflict", "processed_content_conflict");
        return "duplicate";
      }
      if (stored.event_type !== "internal.message") throw new DeliveryFailure("permanent", "not_semantic_message");
      let raw: unknown;
      try { raw = JSON.parse(stored.payload) as unknown; } catch { throw new DeliveryFailure("permanent", "invalid_envelope"); }
      const result = parseAgentMessage(raw);
      if (!result.ok) throw new DeliveryFailure("permanent", result.error);
      const message = result.message;
      if (message.messageId !== claim.message_id || message.runId !== claim.run_id || message.taskId !== claim.task_id ||
          message.attemptId !== claim.attempt_id || message.expectedRevision !== claim.expected_revision) throw new DeliveryFailure("conflict", "delivery_identity_mismatch");
      this.assertAuthority(message);
      const returned: unknown = handler(message);
      if (returned && typeof (returned as {then?: unknown}).then === "function") throw new DeliveryFailure("uncertain", "async_consumer_not_allowed");
      appendDurableEvent(this.database, "internal.message.processed", {messageId: message.messageId, consumerId: claim.consumer_id}, now, {
        correlation: {taskId: message.taskId, runId: message.runId, attemptId: message.attemptId, correlationId: message.correlationId, causationId: message.messageId, messageId: message.messageId}
      });
      this.database.prepare("INSERT INTO processed_messages (consumer_id,message_id,content_hash,processed_at) VALUES (?,?,?,?)").run(claim.consumer_id, claim.message_id, hash(stored.payload), now);
      return "processed";
    }).immediate();
  }

  public complete(claim: DeliveryClaim, now: string): void {
    this.database.transaction(() => {
      this.assertClaim(claim, now);
      const processed = this.processed(claim);
      const stored = this.database.prepare("SELECT payload FROM outbox WHERE id=?").get(claim.message_id) as {payload: string};
      if (!processed || processed.content_hash !== hash(stored.payload)) throw new DeliveryFailure("conflict", "missing_processed_acknowledgement");
      this.acknowledge(claim, now);
    }).immediate();
  }

  public fail(claim: DeliveryClaim, now: string, error: DeliveryFailure): void {
    this.database.transaction(() => {
      this.assertClaim(claim, now);
      if (this.processed(claim)) { this.complete(claim, now); return; }
      if (error.classification !== "transient" || claim.attempt_count >= this.maxAttempts) { this.terminal(claim, now, error); return; }
      const next = new Date(Date.parse(now) + Math.min(8000, 1000 * 2 ** (claim.attempt_count - 1))).toISOString();
      const code = this.safeCode(error.code);
      this.database.prepare(`UPDATE message_deliveries SET status='pending',next_attempt_at=?,error_class='transient',reason=?,
        claim_token=NULL,claim_expires_at=NULL WHERE consumer_id=? AND message_id=?`).run(next, code, claim.consumer_id, claim.message_id);
      this.finishAttempt(claim, now, "transient", code);
    }).immediate();
  }

  public deadLetters(): readonly DeliveryRecord[] {
    return this.database.prepare(`SELECT d.*,o.payload FROM message_deliveries d JOIN outbox o ON o.id=d.message_id
      WHERE d.status IN ('dead_letter','policy','conflict','uncertain') ORDER BY d.completed_at,d.consumer_id,d.message_id`).all() as DeliveryRecord[];
  }

  private assertClaim(claim: DeliveryClaim, now: string): void {
    iso(now);
    if (!this.database.prepare(`SELECT 1 FROM message_deliveries WHERE consumer_id=? AND message_id=? AND status='claimed'
      AND claim_token=? AND claim_expires_at>?`).get(claim.consumer_id, claim.message_id, claim.claim_token, now)) throw new DeliveryFailure("conflict", "claim_expired_or_replaced");
  }
  private processed(claim: DeliveryClaim): {content_hash: string} | undefined {
    return this.database.prepare("SELECT content_hash FROM processed_messages WHERE consumer_id=? AND message_id=?").get(claim.consumer_id, claim.message_id) as {content_hash: string} | undefined;
  }
  private assertAuthority(message: AgentMessage): void {
    if (message.sender.agentId !== "orchestrator" || message.sender.role !== "orchestrator" ||
        message.authorization.principalId !== "orchestrator" || message.authorization.delegationChain.length !== 0 ||
        message.authorization.capabilityGrantId !== null) throw new DeliveryFailure("policy", "internal_authorization_denied");
    const state = message.messageType === "review.requested" ? "verification" : "running";
    if (!this.database.prepare(`SELECT 1 FROM runs r JOIN attempts a ON a.run_id=r.id WHERE r.id=? AND r.task_id=? AND a.id=?
      AND r.lifecycle_revision=? AND r.state=? AND r.recovery_state='none'
      AND NOT EXISTS (SELECT 1 FROM attempts newer WHERE newer.run_id=r.id AND newer.rowid>a.rowid)
      AND NOT EXISTS (SELECT 1 FROM runs newer WHERE newer.task_id=r.task_id AND newer.rowid>r.rowid)`
    ).get(message.runId, message.taskId, message.attemptId, message.expectedRevision, state)) throw new DeliveryFailure("conflict", "stale_lifecycle_or_attempt");
  }
  private acknowledge(claim: DeliveryClaim, now: string): void {
    this.database.prepare(`UPDATE message_deliveries SET status='acknowledged',completed_at=?,claim_token=NULL,claim_expires_at=NULL
      WHERE consumer_id=? AND message_id=?`).run(now, claim.consumer_id, claim.message_id);
    this.finishAttempt(claim, now, "acknowledged", null);
    // Generic audit publication is separate from consumer acknowledgement. Complete this
    // semantic outbox record only when every explicitly registered consumer committed.
    this.database.prepare(`UPDATE outbox SET published_at=? WHERE id=? AND NOT EXISTS
      (SELECT 1 FROM message_deliveries WHERE message_id=? AND status<>'acknowledged')`).run(now, claim.message_id, claim.message_id);
  }
  private safeCode(code: string): string { return /^[a-z][a-z0-9_]{0,99}$/.test(code) ? code : "consumer_failure"; }
  private finishAttempt(claim: DeliveryClaim, now: string, disposition: string, reason: string | null): void {
    this.database.prepare("UPDATE message_delivery_attempts SET finished_at=?,disposition=?,reason=? WHERE claim_token=? AND finished_at IS NULL").run(now, disposition, reason, claim.claim_token);
  }
  private terminal(claim: DeliveryClaim, now: string, error: DeliveryFailure): void {
    const status = error.classification === "transient" || error.classification === "permanent" ? "dead_letter" : error.classification;
    const code = this.safeCode(error.code);
    this.database.prepare(`UPDATE message_deliveries SET status=?,completed_at=?,error_class=?,reason=?,claim_token=NULL,claim_expires_at=NULL
      WHERE consumer_id=? AND message_id=?`).run(status, now, error.classification, code, claim.consumer_id, claim.message_id);
    this.finishAttempt(claim, now, status, code);
    let raw: unknown;
    try { raw = JSON.parse(claim.payload) as unknown; } catch { raw = null; }
    const parsed = parseAgentMessage(raw);
    if (parsed.ok && parsed.message.messageId === claim.message_id && parsed.message.runId === claim.run_id &&
        parsed.message.taskId === claim.task_id && parsed.message.attemptId === claim.attempt_id &&
        parsed.message.expectedRevision === claim.expected_revision) {
      const message = parsed.message;
      let authorized = true;
      try {
        this.assertAuthority(message);
      } catch { authorized = false; }
      if (authorized) {
        // Required actions have different owner states: task progress belongs to the
        // running worker, while review intake starts only after worker verification.
        const fromState = message.messageType === "task.progress" ? "running" : "verification";
        const uncertain = error.classification === "uncertain";
        const nextState = uncertain
          ? message.messageType === "task.progress" ? "recovery_required" : "inconclusive"
          : "blocked";
        const recoveryState = uncertain ? "recovery_required" : "none";
        const updated = this.database.prepare(`UPDATE runs SET state=?,recovery_state=? WHERE id=? AND task_id=? AND state=?
          AND lifecycle_revision=? AND recovery_state='none'
          AND EXISTS (SELECT 1 FROM attempts a WHERE a.id=? AND a.run_id=runs.id
            AND NOT EXISTS (SELECT 1 FROM attempts newer WHERE newer.run_id=runs.id AND newer.rowid>a.rowid))
          AND NOT EXISTS (SELECT 1 FROM runs newer WHERE newer.task_id=runs.task_id AND newer.rowid>runs.rowid)`
        ).run(nextState, recoveryState, claim.run_id, claim.task_id, fromState, claim.expected_revision, claim.attempt_id);
        if (updated.changes) {
          appendDurableEvent(this.database, "run.state_changed", {
            runId: claim.run_id, from: fromState, state: nextState, recoveryState, reason: code
          }, now, {correlation: {taskId: claim.task_id, runId: claim.run_id, attemptId: claim.attempt_id,
            correlationId: claim.correlation_id, causationId: claim.message_id}});
          this.database.prepare("UPDATE tasks SET status='blocked' WHERE id=? AND status IN ('intake','planned')").run(claim.task_id);
          if (uncertain) this.database.prepare(`INSERT INTO recovery (run_id,state,reason,observed_at) VALUES (?,'recovery_required',?,?)
            ON CONFLICT(run_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,observed_at=excluded.observed_at`).run(claim.run_id, code, now);
        }
      }
    }
    appendDurableEvent(this.database, "internal.message.delivery_failed", {messageId: claim.message_id, consumerId: claim.consumer_id, classification: error.classification, code, status}, now, {
      correlation: {taskId: claim.task_id, runId: claim.run_id, attemptId: claim.attempt_id, correlationId: claim.correlation_id, causationId: claim.message_id, messageId: claim.message_id}
    });
  }
}
