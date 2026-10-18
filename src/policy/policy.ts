import { createHash, randomUUID } from "node:crypto";
import type { ActionContext } from "../shared/domain";

export type PolicyDecision =
  | "allowed"
  | "approval_required"
  | "denied"
  | "blocked";
export type PolicyReasonCode =
  | "POLICY_ALLOWED"
  | "APPROVAL_REQUIRED"
  | "PROHIBITED_OPERATION"
  | "MISSING_CAPABILITY"
  | "MISSING_EVIDENCE"
  | "UNRESOLVED_PREREQUISITE"
  | "INVALID_POLICY_INPUT"
  | "POLICY_EVALUATION_FAILED";
export type ApprovalRejectionReason =
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_CONSUMED"
  | "APPROVAL_CONTEXT_MISMATCH"
  | "APPROVAL_POLICY_MISMATCH";
export type RiskTier = 1 | 2 | 3;

export interface PolicyAction {
  readonly operation: string;
  readonly context: ActionContext;
  readonly riskTier: RiskTier;
  readonly prohibited: boolean;
  readonly capabilityVerified: boolean;
  readonly evidenceComplete: boolean;
  readonly prerequisitesResolved: boolean;
}

export interface PolicyDecisionRecord {
  readonly id: string;
  readonly policyVersion: string;
  readonly decision: PolicyDecision;
  readonly reasonCode: PolicyReasonCode;
  readonly reason: string;
  readonly action: PolicyAction;
  readonly actionDigest: string;
  readonly evaluatedAt: string;
}

export interface ApprovalRequest {
  readonly runId: string;
  readonly action: PolicyAction;
  readonly policyVersion: string;
  readonly expiresAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidPolicyAction(value: unknown): value is PolicyAction {
  if (!isRecord(value) || !isRecord(value.context)) return false;
  const context = value.context;
  return (
    typeof value.operation === "string" &&
    (value.riskTier === 1 || value.riskTier === 2 || value.riskTier === 3) &&
    typeof value.prohibited === "boolean" &&
    typeof value.capabilityVerified === "boolean" &&
    typeof value.evidenceComplete === "boolean" &&
    typeof value.prerequisitesResolved === "boolean" &&
    typeof context.operation === "string" &&
    typeof context.target === "string" &&
    Array.isArray(context.arguments) &&
    context.arguments.every((argument) => typeof argument === "string") &&
    (typeof context.payload === "string" || context.payload === null)
  );
}

function canonicalContext(context: ActionContext): string {
  return JSON.stringify({
    operation: context.operation,
    target: context.target,
    arguments: [...context.arguments],
    payload: context.payload
  });
}

export function actionDigest(action: PolicyAction): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: action.operation,
        context: canonicalContext(action.context),
        riskTier: action.riskTier
      })
    )
    .digest("hex");
}

export function evaluatePolicy(
  action: PolicyAction,
  policyVersion = "policy-v1"
): PolicyDecisionRecord {
  const evaluatedAt = new Date().toISOString();
  const validAction = isValidPolicyAction(action);
  const digest = validAction ? actionDigest(action) : "";
  if (
    !validAction ||
    typeof policyVersion !== "string" ||
    policyVersion.trim().length === 0 ||
    action.operation.trim().length === 0 ||
    action.context.operation !== action.operation ||
    action.context.target.trim().length === 0
  ) {
    return {
      id: randomUUID(),
      policyVersion,
      decision: "blocked",
      reasonCode: "INVALID_POLICY_INPUT",
      reason: "Action context is invalid or contradictory",
      action,
      actionDigest: digest,
      evaluatedAt
    };
  }
  if (action.prohibited) {
    return {
      id: randomUUID(),
      policyVersion,
      decision: "denied",
      reasonCode: "PROHIBITED_OPERATION",
      reason: "Operation is prohibited by policy",
      action,
      actionDigest: digest,
      evaluatedAt
    };
  }
  if (!action.capabilityVerified) {
    return {
      id: randomUUID(),
      policyVersion,
      decision: "blocked",
      reasonCode: "MISSING_CAPABILITY",
      reason: "Required capability is missing or unverified",
      action,
      actionDigest: digest,
      evaluatedAt
    };
  }
  if (!action.evidenceComplete) {
    return {
      id: randomUUID(),
      policyVersion,
      decision: "blocked",
      reasonCode: "MISSING_EVIDENCE",
      reason: "Required evidence is missing or inconclusive",
      action,
      actionDigest: digest,
      evaluatedAt
    };
  }
  if (!action.prerequisitesResolved) {
    return {
      id: randomUUID(),
      policyVersion,
      decision: "blocked",
      reasonCode: "UNRESOLVED_PREREQUISITE",
      reason: "Required prerequisite is unresolved",
      action,
      actionDigest: digest,
      evaluatedAt
    };
  }
  const needsApproval = action.riskTier > 1;
  return {
    id: randomUUID(),
    policyVersion,
    decision: needsApproval ? "approval_required" : "allowed",
    reasonCode: needsApproval ? "APPROVAL_REQUIRED" : "POLICY_ALLOWED",
    reason: needsApproval ? "Action requires one-shot approval" : "Action allowed by policy",
    action,
    actionDigest: digest,
    evaluatedAt
  };
}

export function createApprovalRequest(
  runId: string,
  action: PolicyAction,
  policyVersion: string,
  expiresAt: string
): ApprovalRequest {
  const expiration = Date.parse(expiresAt);
  if (
    !runId ||
    !policyVersion.trim() ||
    !Number.isFinite(expiration) ||
    expiration <= Date.now()
  ) {
    throw new Error("Approval expiration must be a future timestamp");
  }
  const decision = evaluatePolicy(action, policyVersion);
  if (decision.decision !== "approval_required") {
    throw new Error("Approval can only be created for approval-required actions");
  }
  return { runId, action, policyVersion, expiresAt };
}

export function approvalMatches(
  approval: {
    actionDigest: string;
    policyVersion: string;
    expiresAt: string;
    consumedAt: string | null;
  },
  action: PolicyAction,
  policyVersion: string
): boolean {
  return checkApproval(approval, action, policyVersion).valid;
}

export function checkApproval(
  approval: {
    actionDigest: string;
    policyVersion: string;
    expiresAt: string;
    consumedAt: string | null;
  },
  action: PolicyAction,
  policyVersion: string
): { readonly valid: true } | { readonly valid: false; readonly reason: ApprovalRejectionReason } {
  if (approval.consumedAt !== null) return { valid: false, reason: "APPROVAL_CONSUMED" };
  if (Date.parse(approval.expiresAt) <= Date.now()) {
    return { valid: false, reason: "APPROVAL_EXPIRED" };
  }
  if (approval.policyVersion !== policyVersion) {
    return { valid: false, reason: "APPROVAL_POLICY_MISMATCH" };
  }
  if (approval.actionDigest !== actionDigest(action)) {
    return { valid: false, reason: "APPROVAL_CONTEXT_MISMATCH" };
  }
  return { valid: true };
}
