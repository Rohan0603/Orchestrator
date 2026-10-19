import type Database from "better-sqlite3";
import type {
  DispatchIntent,
  DispatchRecord,
  EventValidation,
  ProgressCursor
} from "../dispatch/dispatch-contract";
import type { EvidenceRecord } from "../evidence/evidence";
import type { ProgressEvent } from "../harness/adapter-contract";
import { PersistenceError } from "./database";

export class DispatchRepository {
  public constructor(private readonly database: Database.Database) {}

  public persistIntent(record: DispatchRecord): DispatchIntent {
    try {
      const persist = this.database.transaction(() => {
        const intent = record.intent;
        this.database
          .prepare(
            `INSERT INTO dispatch_intents
              (id, dispatch_id, idempotency_key, run_id, attempt_id, task_id, route_json,
               authorization_json, deadline_at, state, created_at)
             VALUES (@id, @dispatchId, @idempotencyKey, @runId, @attemptId, @taskId,
               @route, @authorization, @deadlineAt, @state, @createdAt)`
          )
          .run({
            id: intent.id,
            dispatchId: intent.dispatchId,
            idempotencyKey: intent.idempotencyKey,
            runId: intent.runId,
            attemptId: intent.attemptId,
            taskId: intent.taskId,
            route: JSON.stringify(intent.route),
            authorization: JSON.stringify(intent.authorization),
            deadlineAt: intent.deadlineAt,
            state: intent.state,
            createdAt: intent.createdAt
          });
        this.database
          .prepare("INSERT INTO progress_cursors (dispatch_id, run_id, attempt_id, last_sequence, event_ids) VALUES (?, ?, ?, 0, ?)")
          .run(intent.dispatchId, intent.runId, intent.attemptId, "[]");
        return intent;
      });
      return persist();
    } catch (error) {
      throw new PersistenceError("Dispatch intent persistence failed", { cause: error });
    }
  }

  public recordProgress(event: ProgressEvent, validation: EventValidation): void {
    if (validation.disposition !== "accepted") return;
    try {
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO progress_events
              (event_id, dispatch_id, run_id, attempt_id, sequence, kind, payload_json, occurred_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            event.eventId,
            event.correlation.dispatchId,
            event.correlation.runId,
            event.correlation.attemptId,
            event.sequence,
            event.kind,
            JSON.stringify(event),
            event.occurredAt
          );
        this.database
          .prepare(
            "UPDATE progress_cursors SET last_sequence = ?, event_ids = ? WHERE dispatch_id = ?"
          )
          .run(
            validation.cursor.lastSequence,
            JSON.stringify(validation.cursor.eventIds),
            event.correlation.dispatchId
          );
      })();
    } catch (error) {
      throw new PersistenceError("Progress event persistence failed", { cause: error });
    }
  }

  public recordEvidence(evidence: EvidenceRecord): void {
    try {
      this.database
        .prepare(
          `INSERT INTO evidence_records
            (id, run_id, attempt_id, event_id, kind, provenance, uri, content_hash,
             captured_at, status, independently_verified, completeness_note, criterion_ids)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          evidence.id,
          evidence.correlation.runId,
          evidence.correlation.attemptId,
          evidence.eventId,
          evidence.kind,
          evidence.provenance,
          evidence.uri,
          evidence.contentHash,
          evidence.capturedAt,
          evidence.status,
          evidence.independentlyVerified ? 1 : 0,
          evidence.completenessNote,
          JSON.stringify(evidence.criterionIds)
        );
    } catch (error) {
      throw new PersistenceError("Evidence persistence failed", { cause: error });
    }
  }

  public listEvidence(runId: string, attemptId: string): readonly EvidenceRecord[] {
      try {
        const rows = this.database
          .prepare(
            `SELECT evidence_records.id, evidence_records.run_id, evidence_records.attempt_id,
                    evidence_records.event_id, dispatch_intents.dispatch_id, evidence_records.kind,
                    evidence_records.provenance, evidence_records.uri,
                    content_hash, captured_at, status, independently_verified,
                    completeness_note
             FROM evidence_records
             JOIN dispatch_intents
               ON dispatch_intents.run_id = evidence_records.run_id
              AND dispatch_intents.attempt_id = evidence_records.attempt_id
             WHERE evidence_records.run_id = ? AND evidence_records.attempt_id = ?
             ORDER BY captured_at, evidence_records.id`
          )
          .all(runId, attemptId) as Array<{
            id: string;
            run_id: string;
            attempt_id: string;
            event_id: string;
            dispatch_id: string;
            kind: EvidenceRecord["kind"];
            provenance: EvidenceRecord["provenance"];
            uri: string | null;
            content_hash: string | null;
            captured_at: string;
            status: EvidenceRecord["status"];
            independently_verified: number;
            completeness_note: string | null;
            criterion_ids: string;
          }>;
        return rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          correlation: {
            dispatchId: row.dispatch_id,
            runId: row.run_id,
            attemptId: row.attempt_id
          },
          eventId: row.event_id,
          provenance: row.provenance,
          uri: row.uri,
          contentHash: row.content_hash,
          capturedAt: row.captured_at,
          status: row.status,
          independentlyVerified: row.independently_verified === 1,
          completenessNote: row.completeness_note,
          criterionIds: JSON.parse(row.criterion_ids) as string[]
        }));
      } catch (error) {
        throw new PersistenceError("Evidence lookup failed", { cause: error });
    }
  }

  public createCursor(correlation: ProgressCursor["correlation"]): ProgressCursor {
    return { correlation, lastSequence: 0, eventIds: [] };
  }
}
