import assert from "node:assert/strict";
import test from "node:test";
import { actionDigest, checkApproval, evaluatePolicy } from "../src/policy/policy";
import { assertRunTransition, canTransitionRun } from "../src/shared/domain";
import {
  capabilityOrUnverified,
  evaluateRoute,
  HARNESS_ADAPTER_CONTRACT_VERSION,
  type CapabilityManifest,
  type RouteIdentity,
  type RouteRequirements,
  type TerminalOutcome
} from "../src/harness/adapter-contract";
import {
  classifyTerminalOutcome,
  validateProgressEvent,
  type ProgressCursor
} from "../src/dispatch/dispatch-contract";
import { isAcceptableEvidence, type EvidenceRecord } from "../src/evidence/evidence";
import { evaluateAcceptance } from "../src/acceptance/acceptance";

const context = {
  operation: "run-worker",
  target: "worktree",
  arguments: ["--safe"],
  payload: null
} as const;

const action = {
  operation: "run-worker",
  context,
  riskTier: 2 as const,
  prohibited: false,
  capabilityVerified: true,
  evidenceComplete: true,
  prerequisitesResolved: true
};

const route: RouteIdentity = {
  routeId: "local-opencode",
  provider: { state: "known", name: "provider" },
  model: { state: "known", name: "model" },
  reportedBy: "adapter"
};

const requirements: RouteRequirements = {
  routeId: route.routeId,
  allowExplicitFallback: false,
  capabilities: [
    { key: "run.create", mandatory: true, prerequisites: [] },
    { key: "progress.structured", mandatory: true, prerequisites: [] }
  ]
};

function manifest(
  capabilities: CapabilityManifest["capabilities"]
): CapabilityManifest {
  return {
    contractVersion: HARNESS_ADAPTER_CONTRACT_VERSION,
    adapterId: "adapter",
    generatedAt: "2026-01-01T00:00:00.000Z",
    capabilities
  };
}

function capability(
  key: "run.create" | "progress.structured",
  state: "supported" | "conditional",
  satisfiedPrerequisites: readonly string[] = []
  ) {
  return {
    key,
    state,
    evidence: ["fixture"],
    conditions: [],
    satisfiedPrerequisites,
    version: "1",
    environment: "test"
  } as const;
}

function progress(sequence: number, eventId = `event-${sequence}`) {
  return {
    eventId,
    correlation: {
      dispatchId: "dispatch",
      runId: "run",
      attemptId: "attempt"
    },
    sequence,
    occurredAt: "2026-01-01T00:00:00.000Z",
    kind: "message" as const,
    message: "progress",
    evidence: []
  };
}

function rejectionReason(result: ReturnType<typeof checkApproval>) {
  assert.equal(result.valid, false);
  if (result.valid) throw new Error("Expected approval rejection");
  return result.reason;
}

test("run lifecycle accepts valid transitions and rejects terminal escapes", () => {
  assert.equal(canTransitionRun("ready", "running"), true);
  assert.equal(canTransitionRun("accepted", "running"), false);
  assert.doesNotThrow(() => assertRunTransition("running", "verification"));
  assert.throws(
    () => assertRunTransition("accepted", "running"),
    /Invalid run transition/
  );
});

test("policy blocks malformed, prohibited, and unverified actions", () => {
  assert.equal(
    evaluatePolicy({ ...action, context: { ...context, target: "" } }).reasonCode,
    "INVALID_POLICY_INPUT"
  );
  assert.equal(evaluatePolicy({ ...action, prohibited: true }).decision, "denied");
  assert.equal(
    evaluatePolicy({ ...action, capabilityVerified: false }).reasonCode,
    "MISSING_CAPABILITY"
  );
});

test("policy requires approval only for higher-risk actions", () => {
  assert.equal(evaluatePolicy({ ...action, riskTier: 1 }).decision, "allowed");
  assert.equal(evaluatePolicy(action).decision, "approval_required");
  assert.equal(
    evaluatePolicy({ ...action, evidenceComplete: false }).reasonCode,
    "MISSING_EVIDENCE"
  );
});

test("approval binds exact action context and policy version", () => {
  const approval = {
    actionDigest: actionDigest(action),
    policyVersion: "policy-v1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    consumedAt: null
  };
  assert.deepEqual(checkApproval(approval, action, "policy-v1"), { valid: true });
  assert.equal(
    rejectionReason(
      checkApproval(
        approval,
        { ...action, context: { ...context, target: "other-worktree" } },
        "policy-v1"
      )
    ),
    "APPROVAL_CONTEXT_MISMATCH"
  );
  assert.equal(rejectionReason(checkApproval(approval, action, "policy-v2")), "APPROVAL_POLICY_MISMATCH");
});

test("approval rejects expiry and consumed approvals", () => {
  const base = {
    actionDigest: actionDigest(action),
    policyVersion: "policy-v1",
    expiresAt: "2000-01-01T00:00:00.000Z"
  };
  assert.equal(
    rejectionReason(checkApproval({ ...base, consumedAt: null }, action, "policy-v1")),
    "APPROVAL_EXPIRED"
  );
  assert.equal(
    rejectionReason(
      checkApproval(
        { ...base, expiresAt: "2099-01-01T00:00:00.000Z", consumedAt: "2026-01-01T00:00:00.000Z" },
        action,
        "policy-v1"
      )
    ),
    "APPROVAL_CONSUMED"
  );
});

test("route evaluation blocks missing and unsatisfied conditional capabilities", () => {
  const missing = evaluateRoute(manifest([capability("run.create", "supported")]), route, requirements);
  assert.equal(missing.decision, "blocked");
  assert.deepEqual(missing.missing, ["progress.structured"]);

  const conditional = evaluateRoute(
    manifest([
      capability("run.create", "supported"),
      capability("progress.structured", "conditional")
    ]),
    route,
    {
      ...requirements,
      capabilities: [
        requirements.capabilities[0],
        { key: "progress.structured", mandatory: true, prerequisites: ["stream-v1"] }
      ]
    }
  );
  assert.equal(conditional.decision, "blocked");
  assert.equal(capabilityOrUnverified(manifest([]), "run.create").state, "unverified");
});

test("qualified route requires adapter-reported known identity", () => {
  const ready = evaluateRoute(
    manifest([
      capability("run.create", "supported"),
      capability("progress.structured", "supported")
    ]),
    route,
    requirements
  );
  assert.equal(ready.decision, "ready");
  assert.equal(
    evaluateRoute(
      manifest([
        capability("run.create", "supported"),
        capability("progress.structured", "supported")
      ]),
      { ...route, reportedBy: "orchestrator" },
      requirements
    ).decision,
    "blocked"
  );
});

test("progress accepts increasing events and rejects duplicates or wrong correlation", () => {
  const cursor: ProgressCursor = {
    correlation: progress(0).correlation,
    lastSequence: 0,
    eventIds: []
  };
  const accepted = validateProgressEvent(progress(1), cursor);
  assert.equal(accepted.disposition, "accepted");
  assert.equal(accepted.cursor.lastSequence, 1);
  assert.equal(validateProgressEvent(progress(1), accepted.cursor).disposition, "duplicate");
  assert.equal(validateProgressEvent(progress(0, "old"), accepted.cursor).disposition, "duplicate");
  assert.equal(
    validateProgressEvent(
      { ...progress(2), correlation: { ...progress(2).correlation, runId: "other-run" } },
      accepted.cursor
    ).disposition,
    "quarantined"
  );
});

test("evidence acceptance requires orchestrator verification and completeness", () => {
  const evidence: EvidenceRecord = {
    id: "evidence",
    kind: "check",
    correlation: progress(1).correlation,
    eventId: "event-1",
    provenance: "orchestrator_verified",
    uri: "file:///check.txt",
    contentHash: null,
    capturedAt: "2026-01-01T00:00:00.000Z",
    status: "present",
    independentlyVerified: true,
    completenessNote: null
  };
  assert.equal(isAcceptableEvidence(evidence), true);
  assert.equal(
    isAcceptableEvidence({ ...evidence, provenance: "worker_reported" }),
    false
  );
  assert.equal(isAcceptableEvidence({ ...evidence, status: "incomplete" }), false);
});

test("acceptance blocks missing independent review and accepts complete evidence", () => {
  assert.deepEqual(
    evaluateAcceptance({
      criteriaVerified: true,
      deterministicChecksPassed: true,
      evidenceComplete: false,
      independentReview: "blocked"
    }),
    { decision: "blocked", reason: "Independent review is unavailable" }
  );
  assert.deepEqual(
    evaluateAcceptance({
      criteriaVerified: true,
      deterministicChecksPassed: true,
      evidenceComplete: true,
      independentReview: "passed"
    }),
    { decision: "accepted", reason: "All acceptance gates passed" }
  );
});

test("acceptance rejects reviewer findings and blocks inconclusive review", () => {
  assert.deepEqual(
    evaluateAcceptance({
      criteriaVerified: true,
      deterministicChecksPassed: true,
      evidenceComplete: true,
      independentReview: "failed"
    }),
    { decision: "rejected", reason: "Independent review rejected the candidate" }
  );
  assert.deepEqual(
    evaluateAcceptance({
      criteriaVerified: true,
      deterministicChecksPassed: true,
      evidenceComplete: true,
      independentReview: "inconclusive"
    }),
    { decision: "blocked", reason: "Required acceptance evidence is incomplete" }
  );
});

test("uncertain terminal outcomes require recovery before acceptance", () => {
  const correlation = progress(1).correlation;
  const outcome = (
    kind: "succeeded" | "cancelled" | "timed_out" | "disconnected" | "inconclusive"
  ): TerminalOutcome => {
    const error = {
      class: "ambiguous" as const,
      code: "AMBIGUOUS",
      message: "State is unknown",
      retryable: false,
      correlation
    };
    if (kind === "inconclusive") {
      return {
        kind,
        correlation,
        reportedAt: "2026-01-01T00:00:00.000Z",
        evidence: [],
        error
      };
    }
    return {
      kind,
      correlation,
      reportedAt: "2026-01-01T00:00:00.000Z",
      evidence: [],
      error: null
    };
  };

  assert.equal(classifyTerminalOutcome(outcome("succeeded")), "verification");
  assert.equal(classifyTerminalOutcome(outcome("cancelled")), "inconclusive");
  assert.equal(classifyTerminalOutcome(outcome("timed_out")), "inconclusive");
  assert.equal(classifyTerminalOutcome(outcome("disconnected")), "recovery_required");
  assert.equal(classifyTerminalOutcome(outcome("inconclusive")), "recovery_required");
});
