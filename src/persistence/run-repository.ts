import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CancellationReport } from "../harness/adapter-contract";
import type { Attempt, OwnershipRecord, Run } from "../shared/domain";
import { assertRunTransition } from "../shared/domain";
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

export interface RunHistoryEntry {
  readonly run: Run;
  readonly attempt: Attempt;
}

interface RunHistoryRow extends RunRow {
  attempt_id: string;
  attempt_outcome: Attempt["outcome"];
  worker_report: string | null;
  attempt_created_at: string;
}

interface OwnershipRow {
  run_id: string;
  attempt_id: string;
  helper_pid: number | null;
  helper_creation_time: string | null;
  worker_pid: number | null;
  worker_creation_time: string | null;
  helper_executable: string;
  protocol_version: string;
  nonce: string;
  state: OwnershipRecord["state"];
  last_status: string;
  cleanup_verified: number;
  uncertainty_reason: string | null;
  updated_at: string;
}

function ownershipFromRow(row: OwnershipRow): OwnershipRecord {
  return {
    runId: row.run_id,
    attemptId: row.attempt_id,
    helperPid: row.helper_pid,
    helperCreationTime: row.helper_creation_time,
    workerPid: row.worker_pid,
    workerCreationTime: row.worker_creation_time,
    helperExecutable: row.helper_executable,
    protocolVersion: row.protocol_version,
    nonce: row.nonce,
    state: row.state,
    lastStatus: row.last_status,
    cleanupVerified: row.cleanup_verified === 1,
    uncertaintyReason: row.uncertainty_reason,
    updatedAt: row.updated_at
  };
}

function attemptFromRow(row: RunHistoryRow): Attempt {
  return {
    id: row.attempt_id,
    runId: row.id,
    outcome: row.attempt_outcome,
    workerReport: row.worker_report,
    createdAt: row.attempt_created_at
  };
}

export class RunRepository {
  public constructor(private readonly database: Database.Database) {}

  public recordOwnership(
    record: OwnershipRecord
  ): void {
    try {
      this.database
        .prepare(
          `INSERT INTO ownership_records
             (run_id, attempt_id, helper_pid, helper_creation_time, helper_executable,
              worker_pid, worker_creation_time, protocol_version, nonce, state, last_status,
              cleanup_verified, uncertainty_reason, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             attempt_id = excluded.attempt_id,
             helper_pid = excluded.helper_pid,
             helper_creation_time = excluded.helper_creation_time,
             worker_pid = excluded.worker_pid,
             worker_creation_time = excluded.worker_creation_time,
             helper_executable = excluded.helper_executable,
             protocol_version = excluded.protocol_version,
             nonce = excluded.nonce,
             state = excluded.state,
             last_status = excluded.last_status,
             cleanup_verified = excluded.cleanup_verified,
             uncertainty_reason = excluded.uncertainty_reason,
             updated_at = excluded.updated_at`
        )
        .run(
          record.runId,
          record.attemptId,
          record.helperPid,
          record.helperCreationTime,
          record.helperExecutable,
          record.workerPid,
          record.workerCreationTime,
          record.protocolVersion,
          record.nonce,
          record.state,
          record.lastStatus,
          record.cleanupVerified ? 1 : 0,
          record.uncertaintyReason,
          record.updatedAt
        );
    } catch (error) {
      throw new PersistenceError("Ownership record persistence failed", { cause: error });
    }
  }

  public ownershipForRun(runId: string): OwnershipRecord | null {
    try {
      const row = this.database
        .prepare("SELECT * FROM ownership_records WHERE run_id = ?")
        .get(runId) as OwnershipRow | undefined;
      return row ? ownershipFromRow(row) : null;
    } catch (error) {
      throw new PersistenceError("Ownership record lookup failed", { cause: error });
    }
  }

  public listUnresolvedOwnership(): readonly OwnershipRecord[] {
    try {
      const rows = this.database
        .prepare(
          "SELECT * FROM ownership_records WHERE cleanup_verified = 0 AND state != 'exited_observed'"
        )
        .all() as OwnershipRow[];
      return rows.map(ownershipFromRow);
    } catch (error) {
      throw new PersistenceError("Unresolved ownership lookup failed", { cause: error });
    }
  }

  public listForTask(taskId: string): readonly RunHistoryEntry[] {
    try {
      const rows = this.database
        .prepare(
          `SELECT runs.*, attempts.id AS attempt_id, attempts.outcome AS attempt_outcome,
                  attempts.worker_report, attempts.created_at AS attempt_created_at
           FROM runs
           JOIN attempts ON attempts.run_id = runs.id
           WHERE runs.task_id = ?
           ORDER BY runs.created_at DESC, attempts.created_at DESC`
        )
        .all(taskId) as RunHistoryRow[];
      return rows.map((row) => ({
        run: runFromRow(row),
        attempt: attemptFromRow(row)
      }));
    } catch (error) {
      throw new PersistenceError("Run history listing failed", { cause: error });
    }
  }

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
        const active = this.database
          .prepare(
            `SELECT 1
             FROM runs
             WHERE task_id = ?
               AND state NOT IN ('accepted', 'rejected', 'blocked', 'inconclusive')
             LIMIT 1`
          )
          .get(taskId);
        if (active) throw new Error("Task already has an active run");
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
             LEFT JOIN ownership_records
               ON ownership_records.run_id = runs.id
             WHERE (
               (
                 attempts.outcome = 'pending'
                 AND runs.state IN ('created', 'ready', 'running')
               )
               OR (
                 ownership_records.cleanup_verified = 0
                 AND runs.state NOT IN (
                   'accepted', 'rejected', 'blocked', 'inconclusive', 'recovery_required'
                 )
               )
             )`
          )
          .all() as RunRow[];
        for (const row of rows) {
          this.database
            .prepare(
              `UPDATE runs
               SET state = 'recovery_required', recovery_state = 'recovery_required'
               WHERE id = ? AND state IN ('created', 'ready', 'running')`
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

  public recordRecoveryOutcome(
    runId: string,
    state: "reconciled" | "recovery_required",
    reason: string,
    observedAt: string
  ): void {
    try {
      this.database.transaction(() => {
        const result = this.database
          .prepare("UPDATE runs SET recovery_state = ? WHERE id = ? AND state = 'recovery_required'")
          .run(state, runId);
        if (result.changes !== 1) throw new Error("Recovery run not found");
        this.database
          .prepare(
            `INSERT INTO recovery (run_id, state, reason, observed_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(run_id) DO UPDATE SET
               state = excluded.state,
               reason = excluded.reason,
               observed_at = excluded.observed_at`
          )
          .run(runId, state, reason, observedAt);
        this.appendAudit("run.recovery_reconciled", { runId, state, reason, observedAt });
      })();
    } catch (error) {
      throw new PersistenceError("Recovery outcome persistence failed", { cause: error });
    }
  }

  public transition(runId: string, state: Run["state"], recoveryState: Run["recoveryState"]): void {
    try {
      this.database.transaction(() => {
        const current = this.database
          .prepare("SELECT state FROM runs WHERE id = ?")
          .get(runId) as { state: Run["state"] } | undefined;
        if (!current) throw new Error("Run not found");
        assertRunTransition(current.state, state);
        const result = this.database
          .prepare("UPDATE runs SET state = ?, recovery_state = ? WHERE id = ?")
          .run(state, recoveryState, runId);
        if (result.changes !== 1) throw new Error("Run not found");
        this.appendAudit("run.state_changed", { runId, state, recoveryState });
      })();
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
          .prepare(
            `SELECT attempts.run_id, runs.state
             FROM attempts JOIN runs ON runs.id = attempts.run_id
             WHERE attempts.id = ?`
          )
          .get(attemptId) as { run_id: string; state: Run["state"] } | undefined;
        if (!attempt) throw new Error("Attempt not found");
        assertRunTransition(attempt.state, runState);
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

  public recordCancellation(
    report: CancellationReport,
    dispatchId: string
  ): void {
    try {
      this.database
        .prepare(
          `INSERT INTO cancellation_requests
            (id, run_id, attempt_id, dispatch_id, state, requested_at, observed_at,
             process_ownership_verified, error_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          report.correlation.runId,
          report.correlation.attemptId,
          dispatchId,
          report.state,
          report.requestedAt,
          report.observedAt,
          report.processOwnershipVerified ? 1 : 0,
          report.error ? JSON.stringify(report.error) : null
        );
    } catch (error) {
      throw new PersistenceError("Cancellation report persistence failed", { cause: error });
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
