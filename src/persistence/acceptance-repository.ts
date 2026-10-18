import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AcceptanceRecord } from "../shared/domain";
import { PersistenceError } from "./database";

export class AcceptanceRepository {
  public constructor(private readonly database: Database.Database) {}

  public record(
    runId: string,
    decision: AcceptanceRecord,
    evaluatedAt = new Date().toISOString()
  ): void {
    try {
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO acceptance_decisions
              (id, run_id, decision, reason, evaluated_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(randomUUID(), runId, decision.decision, decision.reason, evaluatedAt);
        const payload = JSON.stringify({ runId, decision, evaluatedAt });
        const previous = this.database
          .prepare("SELECT event_hash FROM audit_events ORDER BY created_at DESC LIMIT 1")
          .get() as { event_hash: string } | undefined;
        const eventHash = createHash("sha256")
          .update(`${previous?.event_hash ?? ""}acceptance.evaluated${payload}${evaluatedAt}`)
          .digest("hex");
        this.database
          .prepare(
            `INSERT INTO audit_events
              (id, event_type, payload, previous_hash, event_hash, created_at)
             VALUES (?, 'acceptance.evaluated', ?, ?, ?, ?)`
          )
          .run(randomUUID(), payload, previous?.event_hash ?? null, eventHash, evaluatedAt);
      })();
    } catch (error) {
      throw new PersistenceError("Acceptance decision persistence failed", { cause: error });
    }
  }
}
