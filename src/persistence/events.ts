import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AuditEvent, EventCorrelation, OutboxRecord } from "../shared/domain";

export interface PendingEvent extends OutboxRecord {
  readonly eventId: string;
}

export interface DurableEventOptions {
  readonly correlation?: EventCorrelation;
  readonly idempotencyKey?: string;
}

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

function auditFromRow(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    payload: row.payload,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    correlation: JSON.parse(row.correlation_json) as EventCorrelation,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at
  };
}

export function appendDurableEvent(
  database: Database.Database,
  eventType: string,
  payload: unknown,
  createdAt = new Date().toISOString(),
  options: DurableEventOptions = {}
): AuditEvent {
  if (options.idempotencyKey) {
    const existing = database
      .prepare("SELECT * FROM audit_events WHERE idempotency_key = ?")
      .get(options.idempotencyKey) as AuditRow | undefined;
    if (existing) {
      if (
        existing.event_type !== eventType ||
        existing.payload !== JSON.stringify(payload) ||
        existing.correlation_json !== JSON.stringify(options.correlation ?? {})
      ) {
        throw new Error("Event idempotency key reused with different event");
      }
      return auditFromRow(existing);
    }
  }
  const previous = database
    .prepare("SELECT event_hash FROM audit_events ORDER BY created_at DESC, id DESC LIMIT 1")
    .get() as { event_hash: string } | undefined;
  const serialized = JSON.stringify(payload);
  const correlation = options.correlation ?? {};
  const eventHash = createHash("sha256")
    .update(
      `${previous?.event_hash ?? ""}${eventType}${serialized}` +
      `${JSON.stringify(correlation)}${options.idempotencyKey ?? ""}${createdAt}`
    )
    .digest("hex");
  const event: AuditEvent = {
    id: randomUUID(),
    eventType,
    payload: serialized,
    previousHash: previous?.event_hash ?? null,
    eventHash,
    correlation,
    idempotencyKey: options.idempotencyKey ?? null,
    createdAt
  };
  database
    .prepare(
      `INSERT INTO audit_events
        (id, event_type, payload, previous_hash, event_hash, correlation_json, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      event.id,
      event.eventType,
      event.payload,
      event.previousHash,
      event.eventHash,
      JSON.stringify(event.correlation),
      event.idempotencyKey,
      event.createdAt
    );
  database
    .prepare(
      `INSERT INTO outbox       (id, event_type, payload, published_at, attempt_count, next_attempt_at, created_at)
       VALUES (?, ?, ?, NULL, 0, ?, ?)`
    )
    .run(event.id, event.eventType, event.payload, event.createdAt, event.createdAt);
  return event;
}

export class EventRepository {
  public constructor(private readonly database: Database.Database) {}

  public append(
    eventType: string,
    payload: unknown,
    createdAt?: string,
    options?: DurableEventOptions
  ): AuditEvent {
    return this.database.transaction(() => appendDurableEvent(
      this.database,
      eventType,
      payload,
      createdAt,
      options
    ))();
  }

  public pending(limit = 100, now = new Date().toISOString()): readonly PendingEvent[] {
    const rows = this.database
      .prepare(
        `SELECT id, event_type, payload, published_at, attempt_count, next_attempt_at, created_at
         FROM outbox
         WHERE published_at IS NULL
           AND next_attempt_at <= ?
         ORDER BY created_at, id
         LIMIT ?`
      )
      .all(now, limit) as Array<{
      id: string;
      event_type: string;
      payload: string;
      published_at: string | null;
      attempt_count: number;
      next_attempt_at: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      eventId: row.id,
      eventType: row.event_type,
      payload: row.payload,
      publishedAt: row.published_at,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      createdAt: row.created_at
    }));
  }

  public recordAttempt(eventId: string, nextAttemptAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE outbox
         SET attempt_count = attempt_count + 1, next_attempt_at = ?
         WHERE id = ? AND published_at IS NULL`
      )
      .run(nextAttemptAt, eventId);
    if (result.changes !== 1) throw new Error("Pending outbox event not found");
  }

  public markPublished(eventId: string, publishedAt = new Date().toISOString()): void {
    const result = this.database
      .prepare("UPDATE outbox SET published_at = ? WHERE id = ? AND published_at IS NULL")
      .run(publishedAt, eventId);
    if (result.changes === 1) return;
    if (!this.database.prepare("SELECT 1 FROM outbox WHERE id = ?").get(eventId)) {
      throw new Error("Outbox event not found");
    }
  }
}
