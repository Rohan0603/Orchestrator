# Orchestrator MVP qualification report

Audit date: 2026-10-18  
Local checkout: `C:\Users\ponna\Project\Orchestrator`  
Branch: `master`  
HEAD: `37b5f4db3341c115f4b42e421e8076fccb4bed18`  
Working tree: modified and untracked files present; no staged changes.  
Execution model: one sequential lead agent; this report is self-review, not
independent review.

## Operator summary

**Functional engineering MVP: demonstrated with limits. Fully accepted MVP:
no. Release recommendation: `NOT READY — CRITICAL EVIDENCE MISSING`.**

The deterministic Electron/UI/core path, SQLite lifecycle, policy gates,
acceptance fail-closed behavior, and one narrow OpenCode CLI JSON route have
evidence. Three retained real-worker trials changed disposable fixtures and
passed deterministic verification, but all correctly stopped at blocked
acceptance because no independent reviewer was available.

Do not connect OpenCode to the UI yet. Do not enable cancellation or
redispatch after uncertain process state. Next high-value step: qualify
run-owned Windows process lifecycle, then obtain an independent reviewer and
run a broader frozen fixture corpus.

## 1. Scope and access

Inspected local source, tests, package scripts, lifecycle/persistence code,
renderer/preload/main IPC, adapter and experiment records, acceptance/status
documents, and the current uncommitted diff. Public-branch state was not used
as a substitute for local checkout state.

The actual Ponytail skill was already loaded in session state and applied as
reuse-first guidance. No dependency, provider, credential, native binding,
framework migration, live-worker UI route, commit, push, or destructive
process action was performed.

## 2. Baseline and remediation

### Defect register

| ID | Severity | Defect | Root cause | Fix | Regression evidence | Remaining risk |
|---|---|---|---|---|---|---|
| UI-01 | High | Renderer IPC rejection could become an unhandled promise and leave stale controls | `refresh`, task submit, history, and fixture handlers awaited IPC without catches/finally | Added explicit catches, safe messages, and `finally` state restoration in `src/renderer/renderer.ts` | `tests/ui-core.test.ts`; full suite | Rejected-IPC fault injection remains unverified |
| UI-02 | High | Rapid fixture clicks could dispatch duplicate requests | No per-task pending state in renderer | Added `pendingFixtureRuns` and disabled button | UI/core double-click test; durable state shows one run | Core idempotency remains authoritative |
| UI-03 | Medium | Completed fixture result did not refresh visible run history | Handler updated result text only | Refresh history after terminal result | UI/core test waits for persisted attempt display | Restart-visible UI history not separately exercised |
| RUN-01 | Critical | Test cleanup recursively force-killed processes discovered by parent PID | Cleanup treated process-tree ancestry as ownership | Cleanup now terminates only exact `ChildProcess` handle spawned by runner; no guessed descendant termination | `npm test` after runner change: 30/30 | Descendant cleanup is not implemented; timeout leaves this explicit limitation |

## 3. Current validation

Environment: Windows x64, Node `v24.19.0`, npm `12.0.2`, Electron
`44.9.0`, better-sqlite3 `12.11.1`.

| Command | Result | Evidence |
|---|---|---|
| `npm test` | PASS, 30/30 | 11 deterministic, 4 conformance, 5 execution, 8 SQLite, 1 IPC, 1 UI/core |
| `npm exec tsc -- --noEmit` | PASS | no diagnostics |
| `npm run build` | PASS | TypeScript and renderer assets |
| `git diff --check` | PASS | no whitespace errors |
| Trial manifest JSON parse | PASS | `experiments/evidence/2026-10-18/TRIAL_MANIFEST_INDEX.json` |
| `npm run package:win` | PASS | Windows x64 package created at `out\Orchestrator-win32-x64`; packaging is not clean-machine launch, signing, or Application Control evidence |
| `npm audit --json` | PASS | 0 info/low/moderate/high/critical vulnerabilities in current install |

Electron emitted non-fatal GPU/network diagnostics during tests. Existing
test-runner output also includes an expected logged invalid-payload error from
the IPC negative test.

Reproduction:

```powershell
npm test
npm exec tsc -- --noEmit
npm run build
git diff --check
```

## 4. Requirement acceptance matrix

| Area | Status | Evidence | Exit condition |
|---|---|---|---|
| UI task creation/reset | PASS | `tests/ui-core.test.ts` | Keep regression test |
| Renderer pending/error handling | PASS for normal flow | `src/renderer/renderer.ts`, UI/core test | Add deterministic rejected-IPC harness |
| Electron boundary and sender/origin checks | PASS | `tests/ipc-security.test.ts` | Add safe subframe proof |
| SQLite schema/migrations/transactions | PASS | `tests/sqlite-runtime.test.ts` | Test operational retention |
| Policy and risk-tier enforcement | PASS for fixture path | deterministic, SQLite, UI/core tests | Live side-effect trial remains separate |
| Durable dispatch intent | PASS | execution tests and retained trials | Reconcile live process identity |
| Acceptance fail-closed | PASS | acceptance/execution/UI tests | Independent review still required |
| Repair cycles | NOT RUN | no independent reviewer/gold set | Freeze corpus and run review/repair campaign |
| OpenCode CLI JSON | PROVISIONAL | three retained durable trials | Broaden task corpus and verify identity limits |
| OpenCode SDK/server | UNVERIFIED | official docs show HTTP/OpenAPI/SSE surface | Implement only after route authorization and conformance scope |
| ACP | UNVERIFIED | official protocol defines session/cancel/update methods | Separate adapter feasibility and ownership tests |
| Windows ownership/cancellation | BLOCKED | no supported Job Object binding verified | Prove ownership and termination on actual Electron stack |
| Restart after real launch | BLOCKED | process identity cannot be safely reconciled | Persist verified ownership or fail closed |
| Backup/restore | PASS limited | disposable SQLite backup test | Active-run, artifact-link, retention and migration exercise |
| Clean-machine launch/signing | NOT TESTED | unsigned package only | Authorized clean machine and Application Control run |
| Independent review | BLOCKED | single-agent constraint | Separate reviewer and frozen rubric |
| Commercial/release readiness | BLOCKED | unresolved critical gates | Close all critical/high gates with evidence |

## 5. UI/core behavior

The UI remains vanilla HTML/CSS/TypeScript. Fixture UI explicitly says it is
deterministic and does not invoke a provider. Tier 2 and Tier 3 remain
approval-gated and cannot call the fixture route through direct IPC.

Verified in actual Electron:

- startup reaches `Database: connected`;
- task creation persists and successful submission resets fields;
- duplicate submit/run requests are suppressed while pending;
- fixture success is distinct from acceptance;
- run history refreshes after fixture execution;
- independent-review absence renders blocked acceptance;
- tier 2/3 direct fixture calls return `APPROVAL_REQUIRED` with no run rows;
- invalid sender/origin and malformed payload paths remain rejected.

Unverified: deterministic renderer fault injection for each rejected IPC
promise, subframe-specific IPC proof, and UI history across full application
restart.

## 6. Adapter and route comparison

| Capability | CLI JSON | SDK/server | ACP |
|---|---|---|---|
| Current implementation | Provisional adapter | None | None |
| Structured events | Observed JSON event lines | Server exposes SSE/global events per docs | `session/update` notifications |
| Session resume | Not qualified | Server has session APIs; not qualified here | `session/load` if supported |
| Cancellation | Refused until Windows ownership is verified | `/session/:id/abort` exists; OS ownership still unresolved | `session/cancel` exists; OS ownership still unresolved |
| Permission handling | Not independently qualified | Permission API exists | Permission request/response exists |
| Diff/artifact capture | Durable fixture evidence | Server session diff endpoint exists; not integrated | Protocol semantics do not replace filesystem provenance |
| Provider/model identity | Configured/adapter-observed only | API can address provider/model; confirmation unverified | Agent capability/identity semantics need qualification |
| Windows/process complexity | Lowest current implementation cost | Adds long-lived localhost server and session reconciliation | Adds protocol adapter plus agent process ownership |
| Status | **Provisional baseline** | Unresolved | Unresolved |

Official documentation inspected 2026-10-18:

- [OpenCode CLI](https://opencode.ai/docs/cli/) documents non-interactive
  `run`, `--model provider/model`, `--dir`, and attachment to a server.
- [OpenCode server](https://opencode.ai/docs/server/) documents loopback
  `opencode serve`, OpenAPI 3.1, SSE global events, session abort, diff, and
  permission endpoints.
- [OpenCode SDK](https://opencode.ai/docs/sdk/) documents a generated,
  type-safe client over the server API.
- [ACP overview](https://agentclientprotocol.com/protocol/v1/overview)
  documents `initialize`, `session/new`, `session/load`, `session/update`,
  permission requests, and `session/cancel`.

Documentation confirms interfaces exist; it does not qualify this project’s
Windows ownership, provider identity, recovery, or acceptance semantics.

## 7. Historical real-worker evidence

Records under `experiments/results/real-opencode-durable/` are retained and
validated by [TRIAL_MANIFEST_INDEX.json](../experiments/evidence/2026-10-18/TRIAL_MANIFEST_INDEX.json).

| Trial set | Route/model | Worker/verifier | Review/acceptance | Interpretation |
|---|---|---|---|---|
| r5, r6, r7 | OpenCode 1.19.0 CLI JSON / `opencode/mimo-v2.6-flash-free` | All changed `value.txt`; verifier passed | All blocked; no independent reviewer | Repeatability for one narrow disposable fixture only |

r7 reports `{total:18100,input:100,output:46,reasoning:34,cost:0}`. Missing
telemetry in r5/r6 remains unknown, not zero. Provider-confirmed identity,
safe cancellation, broad reliability, repair economics, and acceptance remain
unproven.

## 8. Experiment register

| Experiment | Status | Result |
|---|---|---|
| A deterministic golden path | PASS | fixture/UI/core and durable records |
| B malformed/duplicate event conformance | PASS | deterministic parser/conformance tests |
| C restart/reconciliation | PASS deterministic; BLOCKED live | fixture/database uncertainty blocks replay; live process ownership absent |
| D OpenCode CLI repeatability | PROVISIONAL | three retained trials, one task |
| E repair cycle | BLOCKED | no independent reviewer/frozen gold set |
| F acceptance correctness | PASS deterministic | blocked/inconclusive evidence fails closed |
| G adapter comparison | BLOCKED | SDK/server and ACP not qualified |
| H cancellation/ownership | BLOCKED | no verified ownership mechanism |
| I backup/restore | PASS limited | schema/task-state disposable test only |
| J packaging/clean machine | BLOCKED | unsigned package; no clean-machine run |
| K UI regression/IPC boundary | PASS normal flow | 30/30 after safe runner hardening |
| L metrics/variability | BLOCKED | narrow corpus and partial telemetry |

## 9. Evidence inventory

- [UI/core evidence](../experiments/evidence/2026-10-18/UI_CORE_EVIDENCE.md)
- [UI test results](../experiments/evidence/2026-10-18/UI_TEST_RESULTS.md)
- [UI security results](../experiments/evidence/2026-10-18/UI_SECURITY_RESULTS.md)
- [Acceptance results](../experiments/evidence/2026-10-18/ACCEPTANCE_TEST_RESULTS.md)
- [UI requirement matrix](../experiments/evidence/2026-10-18/UI_REQUIREMENT_MATRIX.md)
- [Full evidence index](../experiments/evidence/2026-10-18/EVIDENCE_INDEX.md)
- [Trial manifest index](../experiments/evidence/2026-10-18/TRIAL_MANIFEST_INDEX.json)
- [Validation evidence](VALIDATION_EVIDENCE.md)
- [Acceptance matrix](MVP_ACCEPTANCE_MATRIX.md)

## 10. Remaining blockers and objective exit criteria

1. **Independent review — critical.** A separate reviewer must evaluate a
   frozen gold set, record findings, and review every bounded repair.
2. **Process ownership/cancellation — critical.** Establish run-owned Windows
   Job Object or equivalent support on the actual Electron stack, then prove
   graceful cancellation, escalation, verified termination, and restart
   reconciliation. Until then, cancellation remains disabled.
3. **Live recovery — high.** Execute controlled crash/restart trials only
   after ownership evidence exists; unknown state must block redispatch.
4. **Route identity — high.** Capture configured, adapter-observed, and
   provider-confirmed identities separately; missing confirmation remains
   inconclusive.
5. **Corpus/metrics — medium.** Run multi-file, failed-verification,
   forbidden-operation, ambiguity, repair, and restart tasks with three
   independent trials, expanding when variability warrants.
6. **Deployment — medium.** Validate active-workflow backup/restore,
   retention, clean-machine launch, signing, and Application Control.

## Final decision

**NOT READY — CRITICAL EVIDENCE MISSING**

The repository demonstrates a useful functional engineering milestone, not a
fully accepted or commercially ready MVP. Passing tests and successful worker
trials do not close independent-review, process-ownership, recovery, or
deployment gates.
