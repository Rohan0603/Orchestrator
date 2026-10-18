# Process Lifecycle Fault Matrix

**Mission date:** 2026-10-18  
**Classification:** simulated state-machine/repository tests unless marked real  
**Production process ownership qualification:** not established; standalone
prototype evidence is marked explicitly below

| Boundary | Expected behavior | Observed evidence | Class | Status |
|---|---|---|---|---|
| Before dispatch intent persistence | No worker side effect; persistence error blocks dispatch | Repository transaction and dispatch tests | Simulated | PASS |
| After intent, before launch | Durable intent remains; outcome becomes recovery-required; no replay | `injected uncertain boundaries require recovery and do not replay dispatch` | Simulated | PASS |
| Process launch failure | Failed outcome rejects; ambiguous failure requires recovery | Adapter terminal/error mapping tests | Simulated | PASS |
| Ownership assignment failure | Must block execution and require recovery; prototype terminates its own suspended process without resuming it | Harness cleanup path; failure injection not run | Real harness code, failure not run | NOT RUN |
| Acknowledgement persistence failure | Must not claim running/owned; recovery barrier required | Repository failure handling coverage | Simulated | PASS |
| Cancellation requested | Request is persisted and sent through adapter | `deadline requires verified cancellation before terminal persistence` | Simulated | PASS |
| Cancellation acknowledged, termination unverified | Remains recovery-required; no terminal success | `deadline with unverified cancellation remains recovery-required` | Simulated | PASS |
| Termination independently verified | May classify cancellation only with verified evidence | Harness `TerminateJobObject`, process waits, and active count zero | Real Windows harness | PASS (prototype only) |
| Worker exits normally | Terminal outcome proceeds to verification, never direct acceptance | Fixture execution test | Simulated | PASS |
| Worker crashes | Ambiguous/disconnected outcome requires recovery | `crash boundaries survive restart and block replay` | Simulated | PASS |
| Descendant remains after direct child exits | Ownership verifier must detect remaining owned process | No Job Object implementation | Real | BLOCKED |
| Application shutdown during execution | Restart reconciliation must fail closed | SQLite restart reconciliation test | Simulated | PASS |
| Application restart with active/uncertain run | Mark recovery-required; prohibit automatic redispatch | `run creation persists intent and restart reconciliation fails closed` | Simulated | PASS |
| Progress persistence failure | Do not silently advance cursor or acceptance | Repository transaction/error tests | Simulated | PASS |
| Terminal persistence failure | Preserve uncertainty and block conflicting actions | Injected terminal boundary tests | Simulated | PASS |
| Duplicate launch request | Existing intent/active run blocks second dispatch | One-active-run and dispatch eligibility tests | Simulated | PASS |
| Duplicate cancellation request | Must be idempotent and not weaken uncertainty | Adapter contract supports correlation; real ownership path absent | Simulated/real split | BLOCKED |
| Concurrent starts for one task | Exactly one active run survives | `run repository enforces one active run` | Simulated SQLite | PASS |
| Stale/contradictory process identity on recovery | Do not reconcile by guessed PID; require recovery | Startup reconciliation source and tests | Simulated | PASS |
| Missing/invalid ownership evidence | Route remains unavailable; no success-shaped fallback | Capability/route negative tests | Simulated | PASS |
| Redispatch after uncertainty | Prohibited until explicit reconciliation clears recovery | Recovery state transition and dispatch tests | Simulated | PASS |
| Job creation failure | No worker launch; intent remains recoverable | No injected creation failure; cleanup path implemented | Not run | NOT RUN |
| Suspended process creation failure | No execution; owned resources only are cleaned | `process_creation_failure=1` | Real Windows harness | PASS (prototype only) |
| Assignment failure | Suspended worker is not resumed; exact process handle is terminated | `assignment_failure_cleanup=1` | Real Windows harness | PASS (prototype only) |
| Job membership verification failure | Worker is not resumed; no success-shaped fallback | Cleanup path implemented; failure injection not run | Not run | NOT RUN |
| Resume failure | Run remains uncertain; no redispatch | `injected_resume_failure_cleanup=1` | Controlled harness seam | PASS (prototype only) |
| Normal owned-process exit | Persist exit evidence and query job state before terminal classification | Containment harness waits and queries owned processes | Real Windows harness | PASS (prototype only) |
| Nonzero owned-process exit | Persist failure and ownership evidence | No nonzero worker scenario | Not run | NOT RUN |
| Cancellation request failure | Preserve running/recovery-required state; no retry by guess | Existing adapter failure mapping | Simulated | PASS |
| Delayed termination verification | Do not report cancellation until active-process query is terminal | Harness waits for process handles and active count zero | Real Windows harness | PASS (prototype only) |
| Shutdown with active worker | Reconcile conservatively; never redispatch from missing PID | SQLite restart reconciliation test | Simulated | PASS |
| PID reuse or stale identity | Reject termination authorization and require recovery | Recovery policy tests | Simulated | PASS |
| Native handle cleanup failure | Preserve uncertainty and diagnostics; no continuation | `active_query_failure_after_owner_close=1`, `owner_close_cleanup=1` | Real Windows harness | PASS (prototype only) |
| Suspended launch before assignment | Worker marker absent before assignment; membership verified before resume | `assigned_before_execution=true pre_resume_active=1` | Real Windows harness | PASS (prototype only) |
| Child and grandchild containment | All disposable processes report membership in owned Job | `contained=true active_before_termination=3` | Real Windows harness | PASS (prototype only) |
| Owned Job termination | Only harness-created Job is terminated; all three processes exit | `terminated_owned_job=true active_after_termination=0 processes_exited=true` | Real Windows harness | PASS (prototype only) |

## Interpretation

PASS entries establish repository/state-machine behavior only. They do not
establish Windows kernel ownership, descendant containment, or real termination.
BLOCKED entries are intentional safety barriers, not skipped passes.

## Exact validation

- `npm test`: PASS, 33/33.
- `npm exec tsc -- --noEmit`: PASS.
- `npm run build`: PASS.
- `npm audit --json`: PASS, 0 vulnerabilities.
- `npm run package:win`: PASS; `out\Orchestrator-win32-x64`.

The standalone prototype is a real Windows process test, but it is not
Electron integration, restart qualification, or production worker
qualification.
