export type TaskStatus = "intake" | "planned" | "blocked" | "completed";
export type RunState =
  | "created"
  | "awaiting_approval"
  | "ready"
  | "running"
  | "verification"
  | "review"
  | "repair"
  | "accepted"
  | "rejected"
  | "blocked"
  | "inconclusive"
  | "recovery_required";
export type AttemptOutcome =
  | "pending"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "disconnected"
  | "inconclusive";
export type RecoveryState = "none" | "uncertain" | "recovery_required" | "reconciled";
export type AcceptanceDecision = "accepted" | "rejected" | "blocked" | "inconclusive";

export interface AcceptanceRecord {
  readonly decision: AcceptanceDecision;
  readonly reason: string;
}

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly riskTier: 1 | 2 | 3;
  readonly status: TaskStatus;
  readonly createdAt: string;
}

export interface Run {
  readonly id: string;
  readonly taskId: string;
  readonly state: RunState;
  readonly routeId: string | null;
  readonly recoveryState: RecoveryState;
  readonly createdAt: string;
}

export interface Attempt {
  readonly id: string;
  readonly runId: string;
  readonly outcome: AttemptOutcome;
  readonly workerReport: string | null;
  readonly createdAt: string;
}

export interface Approval {
  readonly id: string;
  readonly runId: string;
  readonly actionDigest: string;
  readonly context: ActionContext;
  readonly policyVersion: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

export interface ActionContext {
  readonly operation: string;
  readonly target: string;
  readonly arguments: readonly string[];
  readonly payload: string | null;
}

export interface AuditEvent {
  readonly id: string;
  readonly eventType: string;
  readonly payload: string;
  readonly previousHash: string | null;
  readonly eventHash: string;
  readonly createdAt: string;
}

export interface OutboxRecord {
  readonly id: string;
  readonly eventType: string;
  readonly payload: string;
  readonly publishedAt: string | null;
  readonly createdAt: string;
}

export interface EvidenceReference {
  readonly id: string;
  readonly runId: string;
  readonly kind: "diff" | "artifact" | "check" | "review";
  readonly uri: string;
  readonly contentHash: string | null;
  readonly createdAt: string;
}

export interface RecoveryRecord {
  readonly runId: string;
  readonly state: RecoveryState;
  readonly reason: string | null;
  readonly observedAt: string;
}

export interface OwnershipRecord {
  readonly runId: string;
  readonly attemptId: string;
  readonly helperPid: number | null;
  readonly helperCreationTime: string | null;
  readonly workerPid: number | null;
  readonly workerCreationTime: string | null;
  readonly helperExecutable: string;
  readonly protocolVersion: string;
  readonly nonce: string;
  readonly state: "starting" | "running" | "cleanup_verified" | "exited_observed" | "uncertain";
  readonly lastStatus: string;
  readonly cleanupVerified: boolean;
  readonly uncertaintyReason: string | null;
  readonly updatedAt: string;
}

const transitions: Readonly<Record<RunState, readonly RunState[]>> = {
  created: ["awaiting_approval", "ready", "recovery_required", "blocked"],
  awaiting_approval: ["ready", "blocked"],
  ready: ["running", "recovery_required", "blocked"],
  running: ["verification", "rejected", "recovery_required", "blocked"],
  verification: ["review", "rejected", "blocked", "inconclusive"],
  review: ["accepted", "repair", "rejected", "blocked", "inconclusive"],
  repair: ["running", "blocked", "recovery_required"],
  accepted: [],
  rejected: [],
  blocked: [],
  inconclusive: [],
  recovery_required: ["blocked", "ready"]
};

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return transitions[from].includes(to);
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canTransitionRun(from, to)) {
    throw new Error(`Invalid run transition: ${from} -> ${to}`);
  }
}
