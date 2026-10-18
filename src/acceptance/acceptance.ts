import type { AcceptanceRecord } from "../shared/domain";

export interface AcceptanceInput {
  readonly criteriaVerified: boolean;
  readonly deterministicChecksPassed: boolean;
  readonly evidenceComplete: boolean;
  readonly independentReview: "passed" | "failed" | "blocked" | "inconclusive";
}

export function evaluateAcceptance(input: AcceptanceInput): AcceptanceRecord {
  if (!input.criteriaVerified || !input.deterministicChecksPassed) {
    return {
      decision: "rejected",
      reason: "Acceptance criteria or deterministic checks failed"
    };
  }
  if (!input.evidenceComplete || input.independentReview !== "passed") {
    return {
      decision: "blocked",
      reason: input.independentReview === "blocked"
        ? "Independent review is unavailable"
        : "Required acceptance evidence is incomplete"
    };
  }
  return { decision: "accepted", reason: "All acceptance gates passed" };
}
