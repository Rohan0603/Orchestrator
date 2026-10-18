# Commercial-readiness validation

Commercial release is blocked until every applicable hard gate has evidence.
This matrix records current evidence without converting source inspection or
commits into runtime proof.

## Current baseline

| Field | Value |
|---|---|
| Product version | `0.1.0` |
| Validation baseline commit | `df9d3b0637b52195c73f3198243a86887902a3c2` |
| Branch | `master` |
| Remote publication | Not performed by this session |
| Validation execution authorization | Not granted for this session |
| Independent review | Blocked by permanent single-agent rule |
| Current release recommendation | Do not publish |

Status meanings: `pass` requires attached evidence; `fail` requires a
reproducible defect; `blocked` means a prerequisite or authorization is
missing; `inconclusive` means evidence conflicts or cannot establish the
requirement; `implemented-not-validated` means source exists but runtime proof
does not.

## Validation matrix

| ID | Requirement / risk | Method | Expected result | Actual result | Evidence | Status | Commit / version | Defects or remediation |
|---|---|---|---|---|---|---|---|---|
| CR-01 | Type safety, build reproducibility / High | Clean-machine dependency install and deterministic production build | Build succeeds from lockfile with documented tool versions | Not run | None | blocked | `df9d3b0` / `0.1.0` | Authorize build; add reproducible build evidence |
| CR-02 | SQLite migrations, transactions, rollback / Critical | Fresh and upgraded database migration tests; injected persistence failures | Versions advance atomically; failures roll back; no success-shaped fallback | Not run | None | blocked | `df9d3b0` / `0.1.0` | Authorize SQLite runtime and failure exercises |
| CR-03 | Electron security and IPC boundary / Critical | Startup inspection, IPC sender/payload tests, renderer privilege tests, CSP review | Renderer remains sandboxed, isolated, Node-disabled, and narrow-API only | Source flags exist; runtime checks not run | None | implemented-not-validated | `df9d3b0` / `0.1.0` | Run security-focused validation; preserve main-process ownership |
| CR-04 | Policy, risk, exact approval / Critical | Deterministic unit/integration cases for decisions, expiry, context changes, one-shot consumption, persistence failure | Fail closed; no mismatched, expired, consumed, or prohibited action proceeds | Source contracts exist; tests not run | None | implemented-not-validated | `df9d3b0` / `0.1.0` | Add focused tests and durable transaction evidence |
| CR-05 | Dispatch idempotency and evidence provenance / Critical | Deterministic dispatch/event/evidence cases plus persistence failure cases | Duplicate or uncertain dispatch is blocked; invalid evidence cannot satisfy acceptance | Source contracts exist; tests not run | None | implemented-not-validated | `df9d3b0` / `0.1.0` | Add tests; verify schema and cursor behavior at runtime |
| CR-06 | Harness capability and route identity / Critical | Authorized adapter conformance trials against every mandatory capability | Mandatory gaps block; provider/model identity and fallback are explicit | No adapter integrated or exercised | None | blocked | `df9d3b0` / `0.1.0` | Qualify candidate only after conformance evidence |
| CR-07 | Cancellation, deadlines, restart, recovery / Critical | Authorized fault, process-ownership, restart, timeout, disk/persistence failure exercises | Unknown state remains recovery-required; unsafe redispatch is prevented | Not implemented/validated end-to-end | None | blocked | `df9d3b0` / `0.1.0` | Implement remaining lifecycle/recovery behavior, then exercise |
| CR-08 | Dependency, licensing, packaging, installation / High | Vulnerability/license inventory; clean Windows install; package smoke test | Dependencies acceptable; install/startup reproducible; no unsafe scripts/config | npm previously reported 4 moderate and 2 high audit findings; packaging not run | npm install report only | blocked | `df9d3b0` / `0.1.0` | Separate authorization for audit remediation and packaging |
| CR-09 | Regression and release qualification / High | Repeatable deterministic suite, release checklist, clean-machine rerun | Required suite passes at pinned commit; failures retained and triaged | No test suite exists or ran | None | blocked | `df9d3b0` / `0.1.0` | Build test harness and qualification protocol |
| CR-10 | Independent review and acceptance / Critical | Authorized independent human/reviewer evaluation against frozen criteria | Tier 2/3 review is independent; acceptance never derives from worker claim | AI-assisted source review only; independent review unavailable | Commit/source review only | blocked | `df9d3b0` / `0.1.0` | Obtain authorized independent review mechanism; do not waive |
| CR-11 | Nondeterministic behavior / High | Three independent trials initially; expand to 5–10+ when variability/risk warrants | Inputs, configuration, traces, reset steps, and outcome variance retained | No trials run | None | blocked | `df9d3b0` / `0.1.0` | Define experiment protocol after deterministic gates |

## Prioritized remediation plan

1. **P0 — Establish deterministic proof.** Authorize and add TypeScript
   checking/build, unit tests for domain/policy/approval/dispatch/evidence
   invariants, and a reproducible Windows build path.
2. **P0 — Prove durable state.** Exercise migrations on fresh and upgraded
   databases, transaction rollback, unique idempotency constraints, and
   persistence failure handling.
3. **P0 — Prove security boundaries.** Validate Electron startup flags, CSP,
   IPC sender identity, payload rejection, and absence of renderer privileged
   access.
4. **P0 — Complete recovery ownership.** Implement and validate cancellation,
   process ownership, deadlines, restart reconciliation, disk/persistence
   failure handling, and recovery-required dispatch blocking.
5. **P1 — Build adapter qualification evidence.** Compare OpenCode, ACP, and
   approved alternatives only through authorized conformance trials. Keep
   candidate status unqualified until all mandatory checks pass.
6. **P1 — Resolve release hygiene.** Inventory vulnerabilities and licenses,
   document native dependency prerequisites, and validate clean-machine
   installation and packaging under separate authorization.
7. **P1 — Independent review.** Obtain a genuine independent human or
   authorized review mechanism for Tier 2/3 criteria. Self-review cannot close
   this gate.
8. **P2 — Nondeterministic experiments.** Run only after deterministic and
   recovery gates pass; retain trial-level evidence and reset procedures.

## Release stop conditions

Do not recommend marketplace publication while any Critical gate is blocked,
failed, or inconclusive; while runtime/build evidence is absent; while
mandatory adapter capabilities are unqualified; while recovery behavior is
untested; or while required independent review is unavailable. Do not claim a
verified quality, security, coverage, reliability, or AI-free-authorship badge.

Development was AI-assisted in this repository. Existing Copilot
co-author attribution and commit history must remain intact. This document
does not reclassify AI-assisted work as human-only work.
