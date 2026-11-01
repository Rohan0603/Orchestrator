import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Approval } from "../shared/domain";
import type { ApprovalRequest, PolicyDecisionRecord, PolicyAction } from "../policy/policy";
import { actionDigest, checkApproval } from "../policy/policy";
import { PersistenceError } from "./database";
import { appendDurableEvent } from "./events";

interface ApprovalRow {
  id: string;
  run_id: string;
  action_digest: string;
  context_json: string;
  policy_version: string;
  expires_at: string;
  consumed_at: string | null;
}

function approvalFromRow(row: ApprovalRow): Approval {
  return {
    id: row.id,
    runId: row.run_id,
    actionDigest: row.action_digest,
    context: JSON.parse(row.context_json) as Approval["context"],
    policyVersion: row.policy_version,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at
  };
}

export class PolicyRepository {
  public constructor(private readonly database: Database.Database) {}

  public recordDecision(decision: PolicyDecisionRecord): void {
    try {
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO policy_decisions
              (id, policy_version, decision, reason_code, reason, action_json, action_digest, evaluated_at)
             VALUES (@id, @policyVersion, @decision, @reasonCode, @reason, @action, @actionDigest, @evaluatedAt)`
          )
          .run({
            id: decision.id,
            policyVersion: decision.policyVersion,
            decision: decision.decision,
            reasonCode: decision.reasonCode,
            reason: decision.reason,
            action: JSON.stringify(decision.action),
            actionDigest: decision.actionDigest,
            evaluatedAt: decision.evaluatedAt
          });
        this.appendAudit("policy.decision.recorded", decision, undefined, `policy.decision:${decision.id}`);
      })();
    } catch (error) {
      throw new PersistenceError("Policy decision persistence failed", { cause: error });
    }
  }

  public createApproval(request: ApprovalRequest): Approval {
    const approval: Approval = {
      id: randomUUID(),
      runId: request.runId,
      actionDigest: actionDigest(request.action),
      context: request.action.context,
      policyVersion: request.policyVersion,
      expiresAt: request.expiresAt,
      consumedAt: null
    };
    try {
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO approvals
              (id, run_id, action_digest, context_json, policy_version, expires_at, consumed_at)
             VALUES (@id, @runId, @actionDigest, @context, @policyVersion, @expiresAt, NULL)`
          )
          .run({
            id: approval.id,
            runId: approval.runId,
            actionDigest: approval.actionDigest,
            context: JSON.stringify(approval.context),
            policyVersion: approval.policyVersion,
            expiresAt: approval.expiresAt
          });
        this.appendAudit("approval.created", approval, { runId: approval.runId }, `approval.created:${approval.id}`);
      })();
      return approval;
    } catch (error) {
      throw new PersistenceError("Approval creation failed", { cause: error });
    }
  }

  public consumeApproval(id: string, action: PolicyAction, policyVersion: string, expectedRunId?: string): Approval {
    const consume = this.database.transaction(() => {
      const row = this.database
        .prepare("SELECT * FROM approvals WHERE id = ?")
        .get(id) as ApprovalRow | undefined;
      if (!row) throw new Error("Approval not found");
      const approval = approvalFromRow(row);
      if (expectedRunId !== undefined && approval.runId !== expectedRunId) {
        throw new Error("APPROVAL_RUN_MISMATCH");
      }
      const check = checkApproval(approval, action, policyVersion);
      if (!check.valid) {
        throw new Error(check.reason);
      }
      const consumedAt = new Date().toISOString();
      const result = this.database
        .prepare("UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
        .run(consumedAt, id);
      if (result.changes !== 1) throw new Error("Approval consumption failed");
      const consumed = approvalFromRow({
        ...row,
        consumed_at: consumedAt
      });
      this.appendAudit("approval.consumed", consumed, { runId: consumed.runId }, `approval.consumed:${consumed.id}`);
      return consumed;
    });
    try {
      return consume();
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(`Approval consumption failed${error instanceof Error ? `: ${error.message}` : ""}`, { cause: error });
    }
  }

  private appendAudit(
    eventType: string,
    payload: unknown,
    correlation?: { taskId?: string; runId?: string; attemptId?: string; revision?: number },
    idempotencyKey?: string
  ): void {
    appendDurableEvent(this.database, eventType, payload, undefined, {
      correlation,
      idempotencyKey
    });
  }
}
