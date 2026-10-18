# Decision register

| Decision | Status | Evidence |
|---|---|---|
| SQLite is authoritative for lifecycle state | Provisionally supported | Runtime migration, transaction, repository, and restart tests pass |
| Worker success cannot imply acceptance | Supported for deterministic path | Acceptance tests and persisted blocked decision |
| Persist dispatch intent before adapter call | Supported for deterministic path | Execution and crash-boundary tests pass |
| Unknown outcome requires recovery | Supported for deterministic path | Recovery tests pass; no automatic replay |
| Mandatory unverified capability blocks route | Supported for contract path | Route and execution tests pass |
| Local fixture adapter | Test-only | Deterministic conformance fixture; not a provider qualification |
| OpenCode/CLI/SDK/ACP winner | Unresolved | No live adapter conformance evidence |
| Windows Job Object ownership | Blocked | Supported binding and verified process exercise not established |
| Independent review effectiveness | Blocked | Independent reviewer/evaluation set unavailable |
| Commercial readiness | Rejected for current MVP | Readiness gates remain blocked or unvalidated |

Source-level tests are not proof of provider compatibility, security
qualification, recovery reliability, or commercial readiness.
