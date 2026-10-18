# Requirement traceability

| ID | Requirement | Implementation/evidence | Status |
|---|---|---|---|
| RT-01 | Durable task/run/attempt state | `src/persistence`, lifecycle tests | PASS |
| RT-02 | Policy, approval, workspace gates before dispatch | dispatch and deterministic tests | PASS |
| RT-03 | Durable dispatch intent before worker side effect | r5/r6/r7 `dispatch.intentPersistedBeforeWorker=true` | PASS |
| RT-04 | Real configured worker route | OpenCode CLI JSON adapter, three durable trials | PROVISIONAL |
| RT-05 | Real file change and diff provenance | retained fixture diffs and SHA-256 hashes | PASS for fixture |
| RT-06 | Deterministic verification | r5/r6/r7 verifier status `passed` | PASS for fixture |
| RT-07 | Independent review before acceptance | no configured independent reviewer | BLOCKED |
| RT-08 | Safe cancellation and ownership | adapter refuses cancellation; Job Object ownership absent | BLOCKED |
| RT-09 | Restart/deadline reconciliation | no live process identity/restart evidence | BLOCKED |
| RT-10 | Capability declaration integrity | conformance tests validate completeness and duplicates | PASS deterministic |
| RT-11 | Provider-confirmed identity | adapter/configuration identity only | INCONCLUSIVE |
| RT-12 | SQLite backup/restore | disposable backup/restore test | PASS limited |
| RT-13 | Clean-machine launch/signing/Application Control | package only; no clean machine or signing evidence | NOT_TESTED |
| RT-14 | Broad real-worker corpus | only one fixed-file task | NOT_TESTED |

Fixture passes do not qualify unresolved live semantics. Self-review in this
package is not independent review.

