import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AcceptanceRecord } from "../shared/domain";
import { PersistenceError } from "./database";
import { appendDurableEvent } from "./events";

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
        appendDurableEvent(
          this.database,
          "acceptance.evaluated",
          { runId, decision, evaluatedAt },
          evaluatedAt,
          { correlation: { runId }, idempotencyKey: `acceptance.evaluated:${runId}:${evaluatedAt}` }
        );
      })();
    } catch (error) {
      throw new PersistenceError("Acceptance decision persistence failed", { cause: error });
    }
  }
}
