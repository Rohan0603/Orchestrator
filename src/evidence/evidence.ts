import type { Correlation } from "../harness/adapter-contract";

export type EvidenceKind = "diff" | "artifact" | "check" | "review" | "log";
export type EvidenceStatus = "present" | "missing" | "incomplete" | "invalid" | "unverified";
export type EvidenceProvenance = "worker_reported" | "adapter_reported" | "orchestrator_verified";

export interface EvidenceRecord {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly correlation: Correlation;
  readonly eventId: string;
  readonly provenance: EvidenceProvenance;
  readonly uri: string | null;
  readonly contentHash: string | null;
  readonly capturedAt: string;
  readonly status: EvidenceStatus;
  readonly independentlyVerified: boolean;
  readonly completenessNote: string | null;
}

export function isAcceptableEvidence(evidence: EvidenceRecord): boolean {
  return (
    evidence.status === "present" &&
    evidence.independentlyVerified &&
    evidence.provenance === "orchestrator_verified" &&
    (evidence.uri !== null || evidence.contentHash !== null)
  );
}
