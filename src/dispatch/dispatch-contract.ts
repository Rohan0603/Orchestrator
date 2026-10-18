import type {
  Attempt,
  Approval,
  Run,
  RunState,
  Task
} from "../shared/domain";
import type {
  AdapterAuthorization,
  CapabilityManifest,
  Correlation,
  CreateRunRequest,
  ProgressEvent,
  RouteEvaluation,
  RouteIdentity,
  RouteRequirements,
  TerminalOutcome
} from "../harness/adapter-contract";
import { evaluateRoute } from "../harness/adapter-contract";
import { checkApproval } from "../policy/policy";
import { evaluateWorkspaceTarget, type WorkspaceTarget } from "../workspace/workspace-contract";
import type { PolicyAction, PolicyDecisionRecord } from "../policy/policy";
import type { EvidenceRecord } from "../evidence/evidence";

export const SINGLE_WORKER_TOPOLOGY = "single-worker" as const;
export const MAX_REPAIR_CYCLES = 2;

export type DispatchIntentState =
  | "not_attempted"
  | "persisted"
  | "acknowledged"
  | "in_progress"
  | "terminal"
  | "uncertain"
  | "recovery_required";

export interface DispatchIntent {
  readonly id: string;
  readonly dispatchId: string;
  readonly idempotencyKey: string;
  readonly correlation: Correlation;
  readonly taskId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly route: RouteIdentity;
  readonly authorization: AdapterAuthorization;
  readonly deadlineAt: string;
  readonly state: DispatchIntentState;
  readonly createdAt: string;
}

export interface DispatchEligibilityInput {
  readonly task: Task;
  readonly run: Run;
  readonly attempt: Attempt;
  readonly policy: PolicyDecisionRecord;
  readonly action: PolicyAction;
  readonly approval: Approval | null;
  readonly workspace: WorkspaceTarget;
  readonly manifest: CapabilityManifest;
  readonly route: RouteIdentity;
  readonly routeRequirements: RouteRequirements;
  readonly deadlineAt: string;
  readonly existingIntent: DispatchIntent | null;
  readonly repairCycles: number;
}

export interface DispatchEligibility {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
  readonly route: RouteEvaluation;
  readonly workspace: ReturnType<typeof evaluateWorkspaceTarget>;
}

function hasAcceptanceCriteria(task: Task): boolean {
  return (
    task.title.trim().length > 0 &&
    task.description.trim().length > 0 &&
    task.acceptanceCriteria.length > 0 &&
    task.acceptanceCriteria.every((criterion) => criterion.trim().length > 0)
  );
}

function approvalIsValid(input: DispatchEligibilityInput): boolean {
  if (input.policy.decision === "allowed") return input.approval === null;
  if (input.policy.decision !== "approval_required" || input.approval === null) {
    return false;
  }
  return checkApproval(input.approval, input.action, input.policy.policyVersion).valid;
}

export function evaluateDispatchEligibility(
  input: DispatchEligibilityInput
): DispatchEligibility {
  const reasons: string[] = [];
  const evaluatedRoute = evaluateRoute(input.manifest, input.route, input.routeRequirements);
  const workspace = evaluateWorkspaceTarget(input.workspace);
  if (!hasAcceptanceCriteria(input.task)) reasons.push("Task or acceptance criteria are invalid");
  if (input.run.state !== "ready" && input.run.state !== "awaiting_approval") {
    reasons.push(`Run state ${input.run.state} is not dispatchable`);
  }
  if (input.attempt.outcome !== "pending") reasons.push("Attempt is not pending");
  if (input.policy.decision !== "allowed" && input.policy.decision !== "approval_required") {
    reasons.push(`Policy decision ${input.policy.decision} does not permit dispatch`);
  }
  if (!approvalIsValid(input)) reasons.push("Required approval is missing or invalid");
  if (workspace.decision !== "ready") reasons.push(`Workspace is ${workspace.decision}`);
  if (!Number.isFinite(Date.parse(input.deadlineAt)) || Date.parse(input.deadlineAt) <= Date.now()) {
    reasons.push("Deadline is missing or expired");
  }
  if (input.attempt.runId !== input.run.id) {
    reasons.push("Attempt is not correlated to run");
  }
  if (!Number.isInteger(input.repairCycles) || input.repairCycles < 0) {
    reasons.push("Repair-cycle count is invalid");
  } else if (input.repairCycles > MAX_REPAIR_CYCLES) {
    reasons.push("Repair-cycle limit exceeded");
  }
  if (input.existingIntent !== null) {
    reasons.push("Dispatch intent already exists; duplicate dispatch is blocked");
  }
  if (input.route.routeId !== input.routeRequirements.routeId) {
    reasons.push("Route identity does not match route requirements");
  }
  return {
    eligible:
      reasons.length === 0 &&
      evaluatedRoute.decision === "ready" &&
      input.repairCycles <= MAX_REPAIR_CYCLES,
    reasons: [
      ...reasons,
      ...evaluatedRoute.reasons
    ],
    route: evaluatedRoute,
    workspace
  };
}

export function createDispatchRecord(
  intent: DispatchIntent,
  task: Task,
  authorization: AdapterAuthorization
): DispatchRecord {
  if (
    intent.dispatchId.trim().length === 0 ||
    intent.idempotencyKey.trim().length === 0 ||
    intent.taskId !== task.id ||
    intent.runId !== authorization.runId ||
    intent.attemptId !== authorization.attemptId ||
    intent.authorization.actionDigest !== authorization.actionDigest
  ) {
    throw new Error("Dispatch intent does not match task or authorization context");
  }
  if (intent.state !== "persisted") {
    throw new Error("Dispatch intent must be persisted before dispatch");
  }
  const request: CreateRunRequest = {
    dispatchId: intent.dispatchId,
    idempotencyKey: intent.idempotencyKey,
    authorization,
    taskDescription: task.description,
    deadlineAt: intent.deadlineAt,
    route: intent.route
  };
  return { intent, request };
}

export interface DispatchRecord {
  readonly intent: DispatchIntent;
  readonly request: CreateRunRequest;
}

export interface ProgressCursor {
  readonly correlation: Correlation;
  readonly lastSequence: number;
  readonly eventIds: readonly string[];
}

export type EventDisposition = "accepted" | "duplicate" | "quarantined";

export interface EventValidation {
  readonly disposition: EventDisposition;
  readonly reason: string;
  readonly cursor: ProgressCursor;
}

export function validateProgressEvent(
  event: ProgressEvent,
  cursor: ProgressCursor
): EventValidation {
  if (
    event.correlation.dispatchId !== cursor.correlation.dispatchId ||
    event.correlation.runId !== cursor.correlation.runId ||
    event.correlation.attemptId !== cursor.correlation.attemptId
  ) {
    return { disposition: "quarantined", reason: "Event correlation mismatch", cursor };
  }
  if (cursor.eventIds.includes(event.eventId) || event.sequence <= cursor.lastSequence) {
    return { disposition: "duplicate", reason: "Duplicate or out-of-order event", cursor };
  }
  return {
    disposition: "accepted",
    reason: "Progress event accepted",
    cursor: {
      correlation: cursor.correlation,
      lastSequence: event.sequence,
      eventIds: [...cursor.eventIds, event.eventId]
    }
  };
}

export function classifyTerminalOutcome(outcome: TerminalOutcome): RunState {
  switch (outcome.kind) {
    case "succeeded":
      return "verification";
    case "failed":
      return "rejected";
    case "cancelled":
      return "inconclusive";
    case "timed_out":
      return "inconclusive";
    case "disconnected":
    case "inconclusive":
      return "recovery_required";
  }
}
