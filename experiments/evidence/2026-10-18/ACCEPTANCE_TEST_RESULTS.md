# Acceptance and state-integrity results

| ID | Invariant | Status | Evidence |
|---|---|---|---|
| ACC-01 | Worker success alone cannot accept | PASS | UI/core result shows `accepted: false`; execution tests |
| ACC-02 | Verification state remains separate | PASS | Fixture run reports execution status and acceptance separately |
| ACC-03 | Missing independent review blocks acceptance | PASS | Existing acceptance test and UI/core test |
| ACC-04 | Tier-2/3 fixture dispatch cannot create runs | PASS | UI/core before/after run-history assertion |
| ACC-05 | Duplicate UI clicks create one run | PASS | UI/core double-click assertion |
| ACC-06 | Unknown/invalid task input fails closed | PASS | Existing IPC security test |
| ACC-07 | Repair re-review and regression cycle | NOT_TESTED | No UI repair workflow exists |
| ACC-08 | Live worker acceptance through UI | NOT_APPLICABLE | Explicitly excluded; route remains experimental |

No task reached genuine acceptance. This is expected and correct under the
missing independent-review gate.

