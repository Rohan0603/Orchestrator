import type {
  CapabilityKey,
  CapabilityManifest,
  Correlation,
  RouteIdentity
} from "./adapter-contract";

export type ConformanceStatus = "pass" | "fail" | "blocked" | "inconclusive" | "not_tested";

export interface ConformanceCheck {
  readonly id: string;
  readonly subject: string;
  readonly requiredEvidence: readonly string[];
  readonly status: ConformanceStatus;
  readonly result: string;
}

export const REQUIRED_CONFORMANCE_CHECKS: readonly ConformanceCheck[] = [
  {
    id: "manifest-completeness",
    subject: "Capability declaration completeness and missing-entry behavior",
    requiredEvidence: ["Manifest declares applicable capabilities", "Missing key resolves to unverified"],
    status: "pass",
    result: "Deterministic manifest tests pass; missing entries resolve to unverified"
  },
  {
    id: "route-identity",
    subject: "Provider, model, adapter, and contract identity fidelity",
    requiredEvidence: ["Observed route identity", "No silent substitution"],
    status: "inconclusive",
    result: "Adapter route identity is recorded; provider-confirmed identity is unavailable"
  },
  {
    id: "event-correlation-order",
    subject: "Progress correlation, monotonic sequence, and duplicate handling",
    requiredEvidence: ["Correlated event trace", "Duplicate/out-of-order handling"],
    status: "pass",
    result: "Fixture ordering/duplicate tests and live progress traces pass"
  },
  {
    id: "terminal-mapping",
    subject: "Terminal outcome and error-class mapping",
    requiredEvidence: ["Outcome trace including inconclusive and ambiguous cases"],
    status: "pass",
    result: "Fixture outcome mapping and live CLI exit outcomes are recorded"
  },
  {
    id: "cancellation-ownership",
    subject: "Cancellation acknowledgement, process ownership, and unverified result",
    requiredEvidence: ["Owned-process cancellation trace", "Unverified termination trace"],
    status: "blocked",
    result: "No supported Windows process ownership mechanism is available"
  },
  {
    id: "deadline-reconciliation",
    subject: "Deadline behavior across disconnect and restart reconciliation",
    requiredEvidence: ["Deadline trace", "Reconciliation report after restart"],
    status: "blocked",
    result: "Deadline cancellation and post-restart live reconciliation are unverified"
  },
  {
    id: "evidence-provenance",
    subject: "Artifact, diff, and evidence provenance",
    requiredEvidence: ["Evidence references with origin and content identity"],
    status: "pass",
    result: "Three durable trials retain orchestrator-verified diff evidence and hashes"
  },
  {
    id: "idempotent-dispatch",
    subject: "Duplicate-dispatch prevention and stable correlation",
    requiredEvidence: ["Repeated idempotency-key trace", "Single execution correlation"],
    status: "pass",
    result: "Fixture idempotency and three durable dispatch records are retained"
  },
  {
    id: "dispatch-eligibility",
    subject: "Policy-first dispatch eligibility and durable intent before side effect",
    requiredEvidence: ["Blocked policy/approval/workspace cases", "Persisted intent before adapter call"],
    status: "pass",
    result: "Deterministic eligibility tests and durable intent-before-worker traces pass"
  }
];

export interface AdapterEvidenceBoundary {
  readonly manifest: CapabilityManifest;
  readonly route: RouteIdentity;
  readonly correlation: Correlation;
  readonly persistedFacts: readonly string[];
}

export const REQUIRED_CAPABILITIES: readonly CapabilityKey[] = [
  "run.create",
  "progress.structured",
  "terminal.outcome",
  "dispatch.idempotency"
];
