# Commercial-readiness validation

Commercial release is blocked until every applicable hard gate has evidence.
This matrix records current evidence without converting source inspection or
commits into runtime proof.

## Current baseline

| Field | Value |
|---|---|
| Product version | `0.1.0` |
| Validation baseline commit | `7edc5d251d2022e202f748e83d7818057c7a10b7` |
| Branch | `master` |
| Remote publication | `origin/master` points to validation baseline |
| Validation execution authorization | Granted for P0 local checks |
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
| CR-01 | Type safety, build reproducibility / High | `npm exec tsc -- --noEmit`; `npm run build`; clean-machine install remains separate | Typecheck/build succeed; clean-machine reproduction succeeds | Typecheck and local production build passed; clean-machine install not run | P0-A record below | implemented-not-validated | `7edc5d2` / `0.1.0` | Run clean-machine reproduction under separate authorization |
| CR-02 | SQLite migrations, transactions, rollback / Critical | Fresh and upgraded database migration tests; injected persistence failures | Versions advance atomically; failures roll back; no success-shaped fallback | Runtime migration/rollback tests not run; source review only | P0-B record below | blocked | `7edc5d2` / `0.1.0` | Authorize SQLite runtime and failure exercises |
| CR-03 | Electron security and IPC boundary / Critical | Startup inspection, IPC sender/payload tests, renderer privilege tests, CSP review | Renderer remains sandboxed, isolated, Node-disabled, and narrow-API only | Static source review confirms flags/CSP/sender and payload guards; runtime checks not run | P0-C record below | implemented-not-validated | `7edc5d2` / `0.1.0` | Run security-focused validation; preserve main-process ownership |
| CR-04 | Policy, risk, exact approval / Critical | Deterministic unit/integration cases for decisions, expiry, context changes, one-shot consumption, persistence failure | Fail closed; no mismatched, expired, consumed, or prohibited action proceeds | Source contracts exist; tests not run | None | implemented-not-validated | `7edc5d2` / `0.1.0` | Add focused tests and durable transaction evidence |
| CR-05 | Dispatch idempotency and evidence provenance / Critical | Deterministic dispatch/event/evidence cases plus persistence failure cases | Duplicate or uncertain dispatch is blocked; invalid evidence cannot satisfy acceptance | Source contracts exist; tests not run | None | implemented-not-validated | `7edc5d2` / `0.1.0` | Add tests; verify schema and cursor behavior at runtime |
| CR-06 | Harness capability and route identity / Critical | Authorized adapter conformance trials against every mandatory capability | Mandatory gaps block; provider/model identity and fallback are explicit | No adapter integrated or exercised | None | blocked | `7edc5d2` / `0.1.0` | Qualify candidate only after conformance evidence |
| CR-07 | Cancellation, deadlines, restart, recovery / Critical | Authorized fault, process-ownership, restart, timeout, disk/persistence failure exercises | Unknown state remains recovery-required; unsafe redispatch is prevented | Not implemented/validated end-to-end | None | blocked | `7edc5d2` / `0.1.0` | Implement remaining lifecycle/recovery behavior, then exercise |
| CR-08 | Dependency, licensing, packaging, installation / High | `npm ls`; `npm audit --json`; package license metadata; native artifact inspection; clean Windows install | Dependencies acceptable; install/startup reproducible; no unsafe scripts/config | MIT/Apache direct licenses recorded; 2 high and 4 moderate vulnerabilities; Electron and SQLite native binaries absent; packaging not run | P0-D record below | blocked | `7edc5d2` / `0.1.0` | Do not upgrade/remediate without authorization; resolve native install and audit gates |
| CR-09 | Regression and release qualification / High | Repeatable deterministic suite, release checklist, clean-machine rerun | Required suite passes at pinned commit; failures retained and triaged | No test suite exists; only typecheck/build ran | P0-A record below | blocked | `7edc5d2` / `0.1.0` | Build focused deterministic test harness and qualification protocol |
| CR-10 | Independent review and acceptance / Critical | Authorized independent human/reviewer evaluation against frozen criteria | Tier 2/3 review is independent; acceptance never derives from worker claim | AI-assisted source review only; independent review unavailable | Commit/source review only | blocked | `7edc5d2` / `0.1.0` | Obtain authorized independent review mechanism; do not waive |
| CR-11 | Nondeterministic behavior / High | Three independent trials initially; expand to 5–10+ when variability/risk warrants | Inputs, configuration, traces, reset steps, and outcome variance retained | No trials run | None | blocked | `7edc5d2` / `0.1.0` | Define experiment protocol after deterministic gates |

## P0 validation record

All commands below ran against commit
`7edc5d251d2022e202f748e83d7818057c7a10b7` with a clean Git working tree.
No application startup, provider call, SQLite open/migration exercise,
process-termination, recovery, or destructive security test ran.

| Check | Actual result | Evidence and interpretation |
|---|---|---|
| TypeScript check | **PASS** — `npm exec tsc -- --noEmit` exited 0 with no diagnostics | Proves compiler acceptance only; not runtime correctness |
| Production build | **PASS** — `npm run build` exited 0 | `dist/` contained compiled main/preload/renderer/shared/Stage 4 output and copied renderer assets; build output is ignored |
| Existing tests | **BLOCKED** — no `*.test.*` or `*.spec.*` files found | No deterministic test suite exists; no superficial tests added |
| Resolved direct dependencies | **RECORDED** — `better-sqlite3@12.11.1`, `electron@38.8.6`, `typescript@5.9.3` | `npm ls ... --depth=0`; lockfile remains unchanged |
| Vulnerability audit | **FAIL/BLOCKED** — 0 critical, 2 high, 4 moderate, 0 low, 0 info | `npm audit --json`; findings were inspected only, not remediated |
| Direct package licenses | **RECORDED** — Electron MIT, better-sqlite3 MIT, TypeScript Apache-2.0 | License metadata inspected; full transitive license inventory remains outstanding |
| Native readiness | **BLOCKED** — `node_modules/electron/dist/electron.exe` absent; better-sqlite3 `.node` binary absent | Install scripts were previously blocked; no policy bypass attempted |
| Electron boundary review | **IMPLEMENTED-NOT-VALIDATED** — source confirms isolation, sandbox, Node disabled, CSP, sender/payload checks, denied window opening | Static review only; no Electron runtime/security qualification |
| Persistence/dispatch review | **IMPLEMENTED-NOT-VALIDATED** — migrations, transactions, unique idempotency keys, progress ordering, explicit errors visible in source | No SQLite runtime, rollback, crash, or failure-injection exercise |

P0 result: compiler/build baseline established, but product remains blocked
for runtime, security qualification, persistence qualification, dependency
remediation, recovery, adapter conformance, deterministic tests, and
independent review.

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
