# Windows Process Ownership Qualification

**Mission date:** 2026-10-18  
**Repository:** Orchestrator v0.1  
**Baseline reviewed:** `6e1d3c5ac638f2a859a7f1d7ff6c84d52031d6d7`  
**Decision:** **PARTIAL — PROTOTYPE OWNERSHIP VERIFIED; PRODUCTION BOUNDARY NOT QUALIFIED**

## Scope

The live worker route must not execute untrusted worker code unless the
launched process and its descendants are owned, cancellable, and independently
verifiable as terminated. A PID or parent-PID relationship is not ownership
evidence.

## Mechanism comparison

| Mechanism | Evidence reviewed | Ownership/descendants | Cancellation/verification | Packaging and decision |
|---|---|---|---|---|
| Windows Job Objects (`CreateJobObjectW`, `AssignProcessToJobObject`, `TerminateJobObject`, query APIs) | Microsoft Windows Job Objects documentation; native prototype | Standalone harness proves assignment before resume and ordinary descendant membership | Harness proves owned-job termination and zero active count; production lifecycle remains unqualified | **Prototype verified; production integration blocked.** |
| Node `child_process` / Electron `utilityProcess` | Node v24.19.0 and Electron v44.9.0 APIs in current dependency tree | Direct child handle only; no descendant containment guarantee | Exit event proves direct child exit, not descendant termination or ownership | **Rejected for live route** |
| `@vscode/windows-process-tree` 0.8.0 | Source/package review recorded in `docs/REUSE_FIRST_DECISIONS.md` | Toolhelp32 parent-PID enumeration; no Job Object ownership | PID-tree reconstruction cannot prove ownership or safe termination | **Rejected** |
| `node-windows-process` 0.1.4 | Source/package review recorded in `docs/REUSE_FIRST_DECISIONS.md` | Single-PID liveness operations; no descendant ownership | Does not provide job membership or verified tree termination | **Rejected** |
| PID-tree heuristic | Existing project security constraints | No ownership; PID reuse and escaping descendants remain possible | Cannot safely distinguish unrelated processes | **Prohibited** |

## Current source behavior

- `executeLocalRun` persists dispatch intent before adapter dispatch.
- Adapter cancellation reports are persisted.
- Failed or unverified cancellation enters `recovery_required`.
- Restart reconciliation marks interrupted runs `recovery_required` rather than
  redispatching.
- `NativeOwnedFixtureAdapter` routes one disposable provider contract through
  `executeLocalRun`; it is a qualification fixture, not production dispatch.
- The live provider route remains disabled. `NativeOwnedFixtureAdapter` is the
  only adapter allowed to use the native ownership coordinator in this slice.

These behaviors are durable lifecycle safeguards. The disposable adapter path
now also has kernel-level ownership evidence through the existing Electron
main-process helper tests.

## Tested and untested

The simulated lifecycle tests pass for verified cancellation, unverified
cancellation, injected launch/terminal uncertainty, restart reconciliation,
duplicate dispatch prevention, and one-active-run enforcement. They do not
prove kernel-level ownership.

Not established on the actual Windows/Electron production boundary:

- Ownership assignment before worker code executes.
- Descendant containment after direct-child exit.
- Job membership after application crash and restart.
- Safe forced termination of only the owned worker.
- Independent termination verification after cancellation.
- Clean-install/package behavior for a native ownership binding.

## Required authorization and next action

Keep the standalone prototype isolated. Next qualification requires a
project-owned production boundary or helper with Electron packaging, durable
identity, restart reconciliation, and cancellation policy. Until that evidence
exists, keep live-worker dispatch and process cancellation disabled.

## Mission follow-up — 2026-10-18

The published candidate
`@deepseek-ai/dsh-win32-process@0.1.2-alpha.2` was inspected from its npm
tarball. It provides `CreateProcessAsUserW`, suspended launch, Job assignment,
and kill-on-close configuration through `koffi`. It does not provide the
required Job membership query, active-process query, verified termination
operation, or durable process identity. Its peer dependencies and Electron
native-loading path also remain unqualified for this application. The
candidate was rejected.

The current shell has no `cl`, `csc`, or `dotnet` on `PATH`, but Visual Studio
Build Tools 2022 and Windows SDK 10.0.26100.0 are installed. Activating
`C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`
exposes MSVC 19.44.35229. This makes a project-owned native build technically
possible, but does not make an unimplemented binding safe or qualified. The
mission prohibition on ad hoc FFI still applies. No weaker PID-tree fallback
was added. Verdict remains **BLOCKED — PROCESS OWNERSHIP NOT QUALIFIED**.

Primary API sources reviewed during this mission:

- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [QueryInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)
- [TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)
- [Process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)

These sources confirm that Job assignment, active-process queries, and
job-scoped termination are available. They do not establish this application's
launch, handle, ABI, restart, or packaged-build behavior.

## Prototype result

`native\job-object-prototype\job_object_harness.cpp` is a standalone,
repository-owned Windows test harness. It uses documented Win32 APIs:

1. `CreateJobObjectW`.
2. `SetInformationJobObject` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
3. `CreateProcessW` with `CREATE_SUSPENDED`.
4. `AssignProcessToJobObject`.
5. `IsProcessInJob` before resume.
6. `ResumeThread`.
7. Child and grandchild creation from the owned worker.
8. `QueryInformationJobObject` for active-process accounting.
9. `TerminateJobObject`.
10. `WaitForSingleObject` and a second accounting query.
11. Deterministic `CloseHandle` cleanup.

Build and execution on 2026-10-18 were real Windows tests. Output:

```text
assigned_before_execution=true pre_resume_active=1
worker_pid=22880 child_pid=29560 grandchild_pid=29416 contained=true active_before_termination=3
terminated_owned_job=true active_after_termination=0 processes_exited=true
harness_exit=0
```

This verifies suspended ordering, direct membership for all three disposable
processes, descendant containment under the tested configuration, owned-Job
termination, process exit, and zero active-process accounting. It does not
qualify Electron integration, packaged loading, restart reconciliation, or
production cancellation. The prototype remains isolated from
`local-execution.ts` and the OpenCode adapter.

Controlled failure/cleanup run also passed:

```text
process_creation_failure=1
assignment_failure_cleanup=1
active_query_failure_after_owner_close=1
injected_resume_failure_cleanup=1
repeated_termination_zero_active=1 repeated_request_result=1
owner_close_cleanup=1
failure_tests_failed=0
failure_tests_exit=0
```

This proves selected native failure seams clean up only handles/processes
created by the harness. It does not inject every possible Windows API failure.

No breakaway flag is enabled. The test covers descendants using ordinary
`CreateProcessW`; it does not claim containment against an explicitly
permitted breakaway or a host process already in a nested Job.

Final verdict: **BLOCKED — PRODUCTION PROCESS OWNERSHIP NOT QUALIFIED**;
prototype milestone: **PASS**.

## Mission follow-up — native helper boundary

The repository now contains a standalone `native\job-object-helper` executable
source and reproducible `npm run build:native-helper` build. The helper owns
one named Job Object, launches a worker suspended, assigns and verifies
Job membership before resume, rejects oversized or version-mismatched
protocol messages, and retains ownership for bounded restart reconciliation
after stdin EOF. `npm run package:win`
places the helper outside the packaged ASAR at
`resources\job-object-helper.exe`; a packaged handshake smoke test passed.

The Electron main process now owns a narrow `NativeOwnershipService` lifecycle
and resolves the helper from development or packaged resource paths.
`NativeOwnershipCoordinator` persists run, attempt, nonce, helper PID,
helper creation-time identity, protocol version, lifecycle state, and cleanup
evidence in SQLite. Main-process shutdown closes the supervised channel.

This is still not production qualification. Startup now consumes unresolved
ownership records, reattaches only when persisted PID, process creation time,
and Job membership match, and records reconciliation outcomes durably. Missing
helpers or stale identities remain recovery-required. The launch protocol
remains limited to a validated executable path without the full authorization,
workspace, argument, and evidence contract. Live dispatch and real-provider
cancellation remain disabled.

Current mission validation also confirmed the packaged helper handshake,
ownership acknowledgement, and cleanup response. Starting the packaged
Electron executable with an isolated temporary user-data directory succeeded
for a five-second startup trial and exact parent shutdown. No packaged helper
remained afterward. This qualifies packaged startup and parent shutdown only;
no interrupted packaged ownership record was exercised, so packaged restart
reattachment and owner-loss qualification remain unproven.

## Toolchain probe

On 2026-10-18, a disposable C++ probe outside the repository was compiled
with MSVC 19.44.35229 after `vcvars64.bat` activation and linked against the
Windows SDK. It called `CreateJobObjectW`, configured
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` with `SetInformationJobObject`, queried
`JobObjectBasicAccountingInformation` with `QueryInformationJobObject`, closed
the Job handle, and exited 0:

```text
job-created active=0 total=0
probe_exit=0
```

This proves compiler, linker, SDK-header, and basic Job API availability only.
It is not an ownership boundary, worker launch test, descendant test,
termination test, Electron ABI test, or packaged-app test.

## Qualification update — 2026-10-19

Application Control was disabled and the packaged application was exercised
through its real renderer IPC surface. The disposable renderer created a
task and called `window.orchestrator.runOwnedFixture` in the packaged
Electron process:

```text
ownershipVerified=true
workerExecutedBeforeOwnership=false
childContained=true
grandchildContained=true
cleanupVerified=true
activeProcessesAfterCleanup=0
```

The packaged executable remained responsive for the test and was then stopped
by its owned process handle. `npm run package:win` completed successfully.

Named Job Objects and recovery events use default local Windows ACLs. This is
acceptable only for the current loopback-only, single-user threat model; it
is not a cross-user security boundary.

An actual helper owner-loss test now terminates only the helper PID identified
by the verified helper handshake, confirms cleanup is not claimed, closes and
reopens SQLite, and runs restart reconciliation. The run becomes
`recovery_required`; the ownership record remains `cleanup_verified=0`.
`npm test` passes with ten native ownership tests, including owner loss and
restart reconciliation.

The live provider path remains deliberately disabled. `executeLocalRun` still
uses harness adapter cancellation rather than the native ownership coordinator,
so this evidence qualifies the explicit owned fixture path only. Production
dispatch, cancellation, and automatic recovery remain disabled.

## Packaged restart recovery trial — 2026-10-19

A disposable Electron test runner persisted a running ownership record while a
detached native helper retained its named Job Object after stdin interruption.
Packaged Electron reopened the same isolated user-data directory and
reconciled the persisted record.

Durable result:

```text
ownership.state=cleanup_verified
cleanup_verified=1
last_status=restart_reconciled
run.recovery_state=reconciled
```

The packaged process remained alive for eight seconds, then was stopped
through its exact child PID. No checkout-owned helper remained. This qualifies
packaged fixture restart reattachment and cleanup. Real OpenCode recovery,
real-provider cancellation, and independent review remain blocked.

Reproduction command: `node experiments/runners/run-packaged-restart.mjs`.
Machine-readable result: `experiments/results/packaged-restart-1792408703493.json`.
