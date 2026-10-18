import type { EvidenceReference } from "../shared/domain";

export const HARNESS_ADAPTER_CONTRACT_VERSION = "harness-adapter-v1";

export type CapabilityState = "supported" | "unsupported" | "conditional" | "unverified";
export type IdentityState = "known" | "unknown" | "unverified";

export type CapabilityKey =
  | "run.create"
  | "progress.structured"
  | "terminal.outcome"
  | "cancellation.request"
  | "cancellation.ownership"
  | "deadline.enforcement"
  | "artifact.provenance"
  | "reconnect"
  | "restart.reconciliation"
  | "dispatch.idempotency";

export interface CapabilityDeclaration {
  readonly key: CapabilityKey;
  readonly state: CapabilityState;
  readonly evidence: readonly string[];
  readonly conditions: readonly string[];
  readonly satisfiedPrerequisites: readonly string[];
  readonly version: string | null;
  readonly environment: string | null;
}

export interface CapabilityManifest {
  readonly contractVersion: string;
  readonly adapterId: string;
  readonly generatedAt: string;
  readonly capabilities: readonly CapabilityDeclaration[];
}

export interface RouteIdentity {
  readonly routeId: string;
  readonly provider: {
    readonly state: IdentityState;
    readonly name: string | null;
  };
  readonly model: {
    readonly state: IdentityState;
    readonly name: string | null;
  };
  readonly reportedBy: "adapter" | "orchestrator";
}

export interface HarnessIdentity {
  readonly adapterId: string;
  readonly harnessName: string;
  readonly adapterVersion: string;
  readonly contractVersion: string;
}

export interface CapabilityRequirement {
  readonly key: CapabilityKey;
  readonly mandatory: boolean;
  readonly prerequisites: readonly string[];
}

export interface RouteRequirements {
  readonly routeId: string;
  readonly capabilities: readonly CapabilityRequirement[];
  readonly allowExplicitFallback: boolean;
}

export type RouteDecision = "ready" | "blocked";

export interface RouteEvaluation {
  readonly decision: RouteDecision;
  readonly route: RouteIdentity;
  readonly missing: readonly CapabilityKey[];
  readonly reasons: readonly string[];
}

export function capabilityOrUnverified(
  manifest: CapabilityManifest,
  key: CapabilityKey
): CapabilityDeclaration {
  return (
    manifest.capabilities.find((capability) => capability.key === key) ?? {
      key,
      state: "unverified",
      evidence: [],
      conditions: [],
      satisfiedPrerequisites: [],
      version: null,
      environment: null
    }
  );
}

function satisfies(
  capability: CapabilityDeclaration,
  requirement: CapabilityRequirement
): boolean {
  return (
    capability.state === "supported" ||
    (capability.state === "conditional" &&
      requirement.prerequisites.length > 0 &&
      requirement.prerequisites.every((prerequisite) =>
        capability.satisfiedPrerequisites.includes(prerequisite)
      ))
  );
}

export function evaluateRoute(
  manifest: CapabilityManifest,
  route: RouteIdentity,
  requirements: RouteRequirements
): RouteEvaluation {
  const missing: CapabilityKey[] = [];
  const reasons: string[] = [];
  if (manifest.contractVersion !== HARNESS_ADAPTER_CONTRACT_VERSION) {
    reasons.push("Capability manifest contract version is incompatible");
  }
  if (requirements.routeId !== route.routeId) {
    reasons.push("Route requirements do not match route identity");
  }
  for (const requirement of requirements.capabilities) {
    const capability = capabilityOrUnverified(manifest, requirement.key);
    if (!satisfies(capability, requirement)) {
      if (requirement.mandatory) missing.push(requirement.key);
      if (requirement.mandatory) {
        reasons.push(
          `${requirement.key} is ${capability.state}; mandatory capability is not qualified`
        );
      } else {
        reasons.push(`${requirement.key} is optional and unavailable`);
      }
    }
  }
  if (route.provider.state !== "known" || route.model.state !== "known") {
    reasons.push("Provider and model route identity is not known");
  }
  if (route.reportedBy !== "adapter") {
    reasons.push("Provider and model route identity is not adapter-reported");
  }
  return {
    decision:
      missing.length === 0 &&
      manifest.contractVersion === HARNESS_ADAPTER_CONTRACT_VERSION &&
      requirements.routeId === route.routeId &&
      route.provider.state === "known" &&
      route.model.state === "known" &&
      route.reportedBy === "adapter"
        ? "ready"
        : "blocked",
    route,
    missing,
    reasons
  };
}

export interface AdapterAuthorization {
  readonly runId: string;
  readonly attemptId: string;
  readonly actionDigest: string;
  readonly approvalId: string | null;
  readonly policyVersion: string;
}

export interface CreateRunRequest {
  readonly dispatchId: string;
  readonly idempotencyKey: string;
  readonly authorization: AdapterAuthorization;
  readonly taskDescription: string;
  readonly deadlineAt: string;
  readonly route: RouteIdentity;
}

export interface Correlation {
  readonly dispatchId: string;
  readonly runId: string;
  readonly attemptId: string;
}

export type AdapterErrorClass =
  | "invalid_request"
  | "authorization_failed"
  | "unsupported_capability"
  | "provider_unavailable"
  | "model_unavailable"
  | "transient"
  | "permanent"
  | "ambiguous"
  | "deadline_exceeded"
  | "cancelled"
  | "duplicate_dispatch"
  | "out_of_order"
  | "incomplete_evidence";

export interface AdapterError {
  readonly class: AdapterErrorClass;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlation: Correlation | null;
}

export type AdapterResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AdapterError };

export type DispatchStatus = "accepted" | "duplicate" | "rejected";

export interface RunCreated {
  readonly correlation: Correlation;
  readonly status: DispatchStatus;
  readonly route: RouteIdentity;
  readonly acceptedAt: string;
}

export type ProgressKind =
  | "started"
  | "message"
  | "artifact"
  | "checkpoint"
  | "warning"
  | "heartbeat";

export interface ProgressEvent {
  readonly eventId: string;
  readonly correlation: Correlation;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly kind: ProgressKind;
  readonly message: string;
  readonly evidence: readonly EvidenceReference[];
}

export type TerminalOutcome =
  | {
      readonly kind: "succeeded" | "failed" | "cancelled" | "timed_out" | "disconnected";
      readonly correlation: Correlation;
      readonly reportedAt: string;
      readonly evidence: readonly EvidenceReference[];
      readonly error: AdapterError | null;
    }
  | {
      readonly kind: "inconclusive";
      readonly correlation: Correlation;
      readonly reportedAt: string;
      readonly evidence: readonly EvidenceReference[];
      readonly error: AdapterError;
    };

export type CancellationState =
  | "requested"
  | "acknowledged"
  | "completed"
  | "unverified";

export interface CancellationReport {
  readonly correlation: Correlation;
  readonly state: CancellationState;
  readonly requestedAt: string;
  readonly observedAt: string | null;
  readonly processOwnershipVerified: boolean;
  readonly error: AdapterError | null;
}

export interface ReconciliationReport {
  readonly correlation: Correlation;
  readonly state: "running" | "completed" | "stopped" | "unknown";
  readonly route: RouteIdentity;
  readonly lastSequence: number | null;
  readonly evidence: readonly EvidenceReference[];
  readonly observedAt: string;
}

export interface HarnessAdapter {
  readonly identity: HarnessIdentity;
  discoverCapabilities(): Promise<CapabilityManifest>;
  createRun(request: CreateRunRequest): Promise<AdapterResult<RunCreated>>;
  subscribeProgress(
    correlation: Correlation,
    handler: (event: ProgressEvent) => void
  ): () => void;
  subscribeTerminal(
    correlation: Correlation,
    handler: (outcome: TerminalOutcome) => void
  ): () => void;
  requestCancellation(correlation: Correlation, deadlineAt: string): Promise<AdapterResult<CancellationReport>>;
  reconcile(correlation: Correlation): Promise<AdapterResult<ReconciliationReport>>;
}
