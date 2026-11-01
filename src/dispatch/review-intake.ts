import type Database from "better-sqlite3";
import { DeliveryFailure } from "../persistence/message-delivery-repository";
import type { DatabaseMessageConsumer } from "./internal-message-dispatcher";

/** Durable intake only. Independent reviewer execution and acceptance remain separate gates. */
export function createReviewIntakeConsumer(database: Database.Database, now: string): DatabaseMessageConsumer {
  return (message) => {
    if (message.messageType !== "review.requested") throw new DeliveryFailure("permanent", "unsupported_consumer_message");
    if (message.recipient.agentId !== "review-intake") throw new DeliveryFailure("policy", "wrong_review_recipient");
    if (message.causationId !== message.payload.reportMessageId) throw new DeliveryFailure("conflict", "report_causation_mismatch");
    const report = database.prepare(`SELECT payload_json FROM worker_messages WHERE id=? AND run_id=? AND attempt_id=?
      AND direction='worker_to_orchestrator' AND kind='report'`).get(message.payload.reportMessageId, message.runId, message.attemptId) as {payload_json: string} | undefined;
    if (!report) throw new DeliveryFailure("conflict", "report_relationship_mismatch");
    let outcome: unknown;
    try { outcome = (JSON.parse(report.payload_json) as {outcome?: unknown}).outcome; } catch { throw new DeliveryFailure("permanent", "invalid_report_payload"); }
    if (outcome !== "succeeded") throw new DeliveryFailure("conflict", "report_not_successful");
    const evidence = database.prepare("SELECT id FROM evidence_records WHERE run_id=? AND attempt_id=? AND event_id=? ORDER BY id").all(message.runId, message.attemptId, message.payload.reportMessageId) as {id: string}[];
    if (JSON.stringify([...message.payload.evidenceIds].sort()) !== JSON.stringify(evidence.map((entry) => entry.id))) throw new DeliveryFailure("conflict", "evidence_relationship_mismatch");
    database.prepare(`INSERT INTO review_requests
      (message_id,task_id,run_id,attempt_id,report_message_id,evidence_ids_json,correlation_id,causation_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(message.messageId, message.taskId, message.runId, message.attemptId,
        message.payload.reportMessageId, JSON.stringify(message.payload.evidenceIds), message.correlationId, message.causationId, now);
  };
}
