import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Attempt, Run } from "../shared/domain";
import { PersistenceError } from "./database";

interface RunRow {
  id: string;
  task_id: string;
  state: Run["state"];
  route_id: string | null;
  recovery_state: Run["recoveryState"];
  created_at: string;
}

function runFromRow(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    state: row.state,
    routeId: row.route_id,
    recoveryState: row.recovery_state,
    createdAt: row.created_at
  };
}

export interface CreatedRun {
  readonly run: Run;
  readonly attempt: Attempt;
}

export class RunRepository {
  public constructor(private readonly database: Database.Database) {}

  public createRun(taskId: string, routeId: string | null, createdAt = new Date().toISOString()): CreatedRun {
    const run: Run = {
      id: randomUUID(),
      taskId,
      state: "created",
      routeId,
      recoveryState: "none",
      createdAt
    };
    const attempt: Attempt = {
      id: randomUUID(),
      runId: run.id,
      outcome: "pending",
      workerReport: null,
      createdAt
    };
    try {
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO runs (id, task_id, state, route_id, recovery_state, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(run.id, run.taskId, run.state, run.routeId, run.recoveryState, run.createdAt);
        this.database
          .prepare(
            `INSERT INTO attempts (id, run_id, outcome, worker_report, created_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(attempt.id, attempt.runId, attempt.outcome, attempt.workerReport, attempt.createdAt);
        this.appendAudit("run.created", { run, attempt });
      })();
      return { run, attempt };
    } catch (error) {
      throw new PersistenceError("Run creation failed", { cause: error });
    }
  }

  public reconcileInterruptedRuns(observedAt: string): readonly Run[] {
    try {
      return this.database.transaction(() => {
        const rows = this.database
          .prepare(
            `SELECT runs.*
             FROM runs
             JOIN attempts ON attempts.run_id = runs.id
             WHERE runs.state = 'running' AND attempts.outcome = 'pending'`
          )
          .all() as RunRow[];
        for (const row of rows) {
          this.database
            .prepare(
              `UPDATE runs
               SET state = 'recovery_required', recovery_state = 'recovery_required'
               WHERE id = ? AND state = 'running'`
            )
            .run(row.id);
          this.database
            .prepare(
              `UPDATE attempts
               SET outcome = 'disconnected', worker_report = ?
               WHERE run_id = ? AND outcome = 'pending'`
            )
            .run("Process state was not safely recoverable after restart", row.id);
          this.database
            .prepare(
              `INSERT INTO recovery (run_id, state, reason, observed_at)
               VALUES (?, 'recovery_required', ?, ?)
               ON CONFLICT(run_id) DO UPDATE SET
                 state = excluded.state,
                 reason = excluded.reason,
                 observed_at = excluded.observed_at`
            )
            .run(row.id, "Interrupted run requires reconciliation", observedAt);
          this.appendAudit("run.recovery_required", {
            runId: row.id,
            reason: "Interrupted run requires reconciliation",
            observedAt
          });
        }

        return rows.map((row) => ({
          ...runFromRow(row),
          state: "recovery_required" as const,
          recoveryState: "recovery_required" as const
        }));
      })();
    } catch (error) {
      throw new PersistenceError("Run reconciliation failed", { cause: error });
    }
  }

  public transition(runId: string, state: Run["state"], recoveryState: Run["recoveryState"]): void {
    try {
      const result = this.database
        .prepare("UPDATE runs SET state = ?, recovery_state = ? WHERE id = ?")
        .run(state, recoveryState, runId);
      if (result.changes !== 1) throw new Error("Run not found");
      this.appendAudit("run.state_changed", { runId, state, recoveryState });
    } catch (error) {
      throw new PersistenceError("Run state transition failed", { cause: error });
    }
  }

  public recordAttemptOutcome(
    attemptId: string,
    outcome: Attempt["outcome"],
    runState: Run["state"],
    recoveryState: Run["recoveryState"],
    workerReport: string | null
  ): void {
    try {
      this.database.transaction(() => {
        const attempt = this.database
          .prepare("SELECT run_id FROM attempts WHERE id = ?")
          .get(attemptId) as { run_id: string } | undefined;
        if (!attempt) throw new Error("Attempt not found");
        const attemptResult = this.database
          .prepare("UPDATE attempts SET outcome = ?, worker_report = ? WHERE id = ? AND outcome = 'pending'")
          .run(outcome, workerReport, attemptId);
        if (attemptResult.changes !== 1) throw new Error("Attempt is no longer pending");
        const runResult = this.database
          .prepare("UPDATE runs SET state = ?, recovery_state = ? WHERE id = ?")
          .run(runState, recoveryState, attempt.run_id);
        if (runResult.changes !== 1) throw new Error("Run not found");
        this.appendAudit("attempt.outcome_recorded", {
          attemptId,
          runId: attempt.run_id,
          outcome,
          runState,
          recoveryState,
          workerReport
        });
      })();
    } catch (error) {
      throw new PersistenceError("Attempt outcome persistence failed", { cause: error });
    }
  }

  private appendAudit(eventType: string, payload: unknown): void {
    const previous = this.database
      .prepare("SELECT event_hash FROM audit_events ORDER BY created_at DESC LIMIT 1")
      .get() as { event_hash: string } | undefined;
    const createdAt = new Date().toISOString();
    const serialized = JSON.stringify(payload);
    const eventHash = createHash("sha256")
      .update(`${previous?.event_hash ?? ""}${eventType}${serialized}${createdAt}`)
      .digest("hex");
    this.database
      .prepare(
        `INSERT INTO audit_events
          (id, event_type, payload, previous_hash, event_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), eventType, serialized, previous?.event_hash ?? null, eventHash, createdAt);
  }
}
