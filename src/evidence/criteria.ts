import { createHash } from "node:crypto";
import type { EvidenceRecord } from "./evidence";

export function acceptanceCriterionId(criterion: string): string {
  return createHash("sha256").update(criterion.trim(), "utf8").digest("hex");
}

export function acceptanceCriterionIds(criteria: readonly string[]): readonly string[] {
  return criteria.map(acceptanceCriterionId);
}

export function evidenceCoversCriteria(
  criteria: readonly string[],
  evidence: readonly EvidenceRecord[]
): boolean {
  const criterionIds = acceptanceCriterionIds(criteria);
  if (new Set(criterionIds).size !== criterionIds.length) return false;
  const covered = new Set<string>();
  for (const item of evidence) {
    if (item.criterionIds.length !== 1) continue;
    const criterionId = item.criterionIds[0];
    if (criterionId && criterionIds.includes(criterionId)) covered.add(criterionId);
  }
  return covered.size === criterionIds.length;
}
