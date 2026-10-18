import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Approval } from "../shared/domain";
import type { ApprovalRequest, PolicyDecisionRecord, PolicyAction } from "../policy/policy";
import { actionDigest, checkApproval } from "../policy/policy";
import { PersistenceError } from "./database";

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
        this.appendAudit("policy.decision.recorded", decision);
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
        this.appendAudit("approval.created", approval);
      })();
      return approval;
    } catch (error) {
      throw new PersistenceError("Approval creation failed", { cause: error });
    }
  }

  public consumeApproval(id: string, action: PolicyAction, policyVersion: string): Approval {
    const consume = this.database.transaction(() => {
      const row = this.database
        .prepare("SELECT * FROM approvals WHERE id = ?")
        .get(id) as ApprovalRow | undefined;
      if (!row) throw new Error("Approval not found");
      const approval = approvalFromRow(row);
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
      this.appendAudit("approval.consumed", consumed);
      return consumed;
    });
    try {
      return consume();
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError("Approval consumption failed", { cause: error });
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
