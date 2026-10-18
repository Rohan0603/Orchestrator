# Validation evidence

Audit date: 2026-10-18. Historical deterministic audit commit: `0fb0070`.
Current implementation/evidence commits: `5f2f132`, `f1958a2`, `048c2a1`,
`090d53a`, `a985051`, `6429b56`, `75f6909`.

Environment for current validation:

- Windows repository checkout, branch `master`
- Node `v24.19.0`, npm `12.0.2`
- Electron `44.9.0`, better-sqlite3 `12.11.1`
- `package-lock.json` SHA-256:
  `A8BDBA8A7BC3D30B7A178974608CC54D91B2FBE38DA70C20B270320BBD554315`

| Command | Exit | Result | Notes |
|---|---:|---|---|
| `npm exec tsc -- --noEmit` | 0 | PASS | No diagnostics |
| `npm test` | 0 | PASS | 33 tests: 12 deterministic, 4 conformance, 7 execution, 8 SQLite, 1 Electron IPC, 1 UI/core |
| `npm run build` | 0 | PASS | TypeScript build and renderer assets |
| `npm audit --json` | 0 | PASS | 0 critical, high, moderate, or low vulnerabilities in current install |
| `git diff --check` | 0 | PASS | No whitespace errors |
| `npm run package:win` | 0 | PASS | `out\Orchestrator-win32-x64` created with Electron 44.9.0 |
| `node experiments/runners/record-trial.mjs ...` | 0 | PASS | Wrote new blocked record to disposable temp directory |
| `node experiments/runners/summarize-results.mjs ...` | 0 | PASS | Generated summary from disposable raw record |

Electron tests emitted non-fatal GPU/network process diagnostics. They did not
fail the suite. The package command proves packaging, not clean-machine launch,
signing, Application Control compatibility, or production worker behavior.

The Electron test runner was hardened after inspection: it now terminates only
the exact `ChildProcess` handle it spawned. It no longer discovers descendants
by parent PID or force-kills them. Descendant cleanup remains unimplemented and
is not represented as verified process ownership.

Executed facts:

- Electron application code ran during the real IPC integration test.
- Earlier audit commands did not invoke a real worker; the later real-worker
  evidence is recorded below.
- No Windows process ownership or cancellation was verified.
- Deadline handling now requests adapter cancellation and fails closed to
  `recovery_required` unless process termination is verified.
- Run persistence now enforces one active run per task and validates lifecycle
  transitions at the repository boundary.
- No genuinely independent review occurred.
- No task reached genuine acceptance; fixture success persisted a blocked
  acceptance decision because independent review was unavailable.

## Real-worker qualification evidence

Validated at commits `5f2f132` (adapter) and `f1958a2` (usage retention):

| Trial set | Route | Result | Evidence |
|---|---|---|---|
| r5, r6, r7 | OpenCode `1.19.0` CLI JSON / `opencode/mimo-v2.6-flash-free` | Three durable executions changed `value.txt`; verifier passed; acceptance blocked | `experiments/results/real-opencode-durable/` |

Each trial used a disposable versioned Git fixture. SQLite dispatch intent
preceded worker invocation; progress and orchestrator-verified diff evidence
were persisted. r7 recorded usage `{total:18100,input:100,output:46,reasoning:34,cost:0}`.
No trial claims independent review or cancellation. CLI JSON is provisionally
supported; SDK/server and ACP remain unresolved.

## Current checkout validation

At commit `75f6909` on Windows with Node `v24.19.0`, npm `12.0.2`, Electron
`44.9.0`, and `better-sqlite3` `12.11.1`:

| Command | Exit | Result |
|---|---:|---|
| `npm test` | 0 | PASS, 33/33 tests |
| `npm exec tsc -- --noEmit` | 0 | PASS |
| `npm run build` | 0 | PASS |
| `npm audit --json` | 0 | PASS, 0 critical/high/moderate/low |
| `npm run package:win` | 0 | PASS, unsigned `out\Orchestrator-win32-x64` |
| `git diff --check` | 0 | PASS |

Electron emitted non-fatal network-service diagnostics during IPC testing.
Package creation is not clean-machine launch, signing, or Application Control
evidence.

The new SQLite backup test proves schema and task-state restoration from a
disposable backup. It does not prove retention, backup scheduling, active-run
recovery, or disaster recovery.

Current qualification rerun on this checkout also passed `npm audit --json`
with zero reported vulnerabilities and `npm run package:win` with exit code
0. These results prove dependency/package generation only; they do not prove
clean-machine launch, signing, Application Control compatibility, or release
readiness.

Phase 3 fresh validation additionally passed `npm exec tsc -- --noEmit`,
`npm run build`, `npm audit --json`, `npm run package:win`, and JSON parsing of
`experiments/evidence/2026-10-18/TRIAL_MANIFEST_INDEX.json`. `npm test` was
re-run separately and passed 30/30. No source behavior changed during this
phase.

## Process-ownership mission rerun

On 2026-10-18, this checkout reran:

- `npm test`: exit 0, 33/33 tests.
- `npm exec tsc -- --noEmit`: exit 0.
- `npm run build`: exit 0.
- `npm audit --json`: exit 0, zero reported vulnerabilities.
- `npm run package:win`: exit 0, unsigned
  `out\Orchestrator-win32-x64` created.
- `git diff --check`: exit 2 because pre-existing modified documentation
  contains trailing whitespace; no source or mission edit caused those lines.

No production Windows Job Object boundary test ran. A standalone native
prototype test is recorded below. No runtime ownership binding was added. No
live-worker dispatch path was enabled. These results do not change the blocked
production ownership verdict.

The earlier `git diff --check` exit-0 entries belong to historical clean
checkpoints. The current exit-2 result belongs to this dirty checkout and is
not silently relabeled. The reported trailing-whitespace lines are in
pre-existing modifications to `docs/FINAL_MVP_QUALIFICATION_2026-10-18.md`
and `experiments/evidence/2026-10-18/EVIDENCE_INDEX.md`.

Toolchain reconnaissance found Visual Studio Build Tools 2022 with MSVC
19.44.35229 and Windows SDK 10.0.26100.0. These tools are usable only after
vcvars64 activation; no native addon was built because no qualified complete
binding or authorized implementation existed.

A disposable probe compiled and ran outside the repository with the activated
toolchain. It created/configured/queried/closed a Job Object and returned:

```text
job-created active=0 total=0
probe_exit=0
```

This validates basic SDK/API availability only. It does not qualify worker
ownership, descendant containment, cancellation, restart reconciliation,
Electron ABI loading, or packaged-app behavior.

## Native prototype validation

Source: `native\job-object-prototype\job_object_harness.cpp`.

Exact build command:

```text
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
cd /d "%TEMP%\orchestrator-job-object-build"
cl /nologo /std:c++20 /W4 /EHsc "C:\Users\ponna\Project\Orchestrator\native\job-object-prototype\job_object_harness.cpp" /Fe:job_object_harness.exe /link /subsystem:console
job_object_harness.exe
```

Compile and run exit: `0`.

Real Windows output:

```text
assigned_before_execution=true pre_resume_active=1
worker_pid=22880 child_pid=29560 grandchild_pid=29416 contained=true active_before_termination=3
terminated_owned_job=true active_after_termination=0 processes_exited=true
harness_exit=0
```

This is OS-boundary evidence for standalone prototype only. It does not
qualify Electron ABI loading, packaged-app loading, restart recovery,
breakaway behavior, or production cancellation. No production source path was
connected.

Controlled failure/cleanup command:

```text
job_object_harness.exe --failure-tests
```

Exit: `0`.

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

These are real Windows API/handle tests for the standalone prototype, with one
explicit pre-resume failure seam. They do not qualify every possible API
failure, Electron integration, or restart recovery.
