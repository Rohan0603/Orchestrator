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
| `npm test` | 0 | PASS | 54 test cases: 51 Electron suites plus 3 runner regression tests |
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
| `npm test` | 0 | PASS, 54/54 test cases |
| `npm exec tsc -- --noEmit` | 0 | PASS |
| `npm run build` | 0 | PASS |
| `npm audit --json` | 0 | PASS, 0 critical/high/moderate/low |
| `npm run package:win` | 0 | PASS, unsigned `out\Orchestrator-win32-x64` |
| `git diff --check` | 0 | PASS |

Electron emitted non-fatal network-service diagnostics during IPC testing.
Package creation is not clean-machine launch, signing, or Application Control
evidence.

## Native protocol handle-inheritance remediation

The native helper launch path now uses `STARTUPINFOEX` with
`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. Only worker stdout and stderr write handles
are explicitly inherited; helper protocol handles are excluded. Job assignment
and membership verification still occur before worker resume.

Validation on 2026-10-19:

| Command | Exit | Result |
|---|---:|---|
| `npm run build:native-helper` | 0 | PASS |
| `npm exec tsc -- -p tsconfig.test.json` | 0 | PASS |
| `npm exec tsc -- --noEmit` | 0 | PASS |
| `node scripts/run-electron-tests.mjs --expected=10 dist-test/tests/native-ownership.test.js` | 0 | PASS, 10/10 |
| `npm test` | 0 | PASS, all configured suites |
| `npm run build` | 0 | PASS |
| `npm run package:win` | 0 | PASS, unsigned `out\Orchestrator-win32-x64` |
| `npm audit --json` | 0 | PASS |
| `git diff --check` | 0 | PASS |

The native regression launches a worker that emits a forged-looking response
token and verifies it is delivered only as owned stdout data; helper response
correlation remains controlled by the helper channel. This closes handle
inheritance at source level and in the targeted runtime test, but does not
qualify real-provider restart recovery or cancellation.

## Restart ownership recovery implementation

The helper now creates a named Job Object and recovery event per run. On
application/helper stdin disconnect, it retains ownership for a bounded
interval instead of destroying the Job Object. A restarted helper can open the
named Job only after validating persisted worker PID, process creation time,
and Job membership. Reconciliation is idempotent at startup because only
unresolved records are retried; already-observed exited records are terminal
and excluded from subsequent retries. Persisted original helper identity is
retained as provenance but is not independently revalidated or replaced.
Already-exited workers use `restart_observed_exited` with
`cleanup_verified=0`; active workers use `restart_reconciled` only after
verified termination. Ownership and recovery updates use separate durable
transactions; recovery remains fail-closed if a crash occurs between them.

Disposable runtime trial on 2026-10-19:

- launched a controlled `ping.exe` worker through the native helper;
- closed the original helper input to simulate application interruption;
- rejected reconciliation with mismatched creation time;
- reattached with matching PID and creation time;
- terminated the owned Job tree and verified cleanup;
- verified unrelated `ping.exe` process remained alive.

This qualifies native fixture restart ownership recovery only. It does not
qualify real OpenCode cancellation, packaged restart recovery, or independent
review.

## CPU-only GPU qualification

The repository has no CUDA, ROCm, DirectML, WebGPU, GPU inference package, or
application hardware-acceleration code. The only GPU-related runtime is
Chromium inside Electron `44.9.0`.

On the qualification host, `Win32_VideoController` reported only
`Microsoft Basic Display Adapter` with `AdapterRAM=0`. Packaged Electron
remained running for five seconds and reached normal startup with both default
arguments and `--disable-gpu`. Electron emitted
`ui\gl\direct_composition_support.cc:254 GetGpuDriverOverlayInfo: Failed to
retrieve video device`; this is Chromium display-device probing, not an
application GPU requirement. The earlier
`Gpu Cache Creation failed: -2` message is likewise Chromium cache
initialization. SQLite, the native Job Object helper, fixture workers, and
Electron test suites do not depend on a physical GPU.

No acceleration flag was added: the application already runs CPU-only, and
`--disable-gpu` did not remove the Chromium device-probe diagnostic. Keeping
default Electron behavior avoids changing desktop rendering without a
demonstrated functional failure.

## Current qualification refresh

OpenCode `1.19.0` is installed at the resolved native executable path under
`%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`. A new disposable
fixture run used the existing `OpenCodeCliAdapter` with
`opencode/mimo-v2.6-flash-free`:

- provider process completed with terminal `succeeded`;
- 16 structured progress events were observed;
- verifier passed and the trial validity field was `true`;
- acceptance remained `blocked` because no independent reviewer is configured.

This is real provider execution evidence, not a fixture adapter result. It
does not qualify native Job ownership or cancellation: the existing OpenCode
adapter reports those capabilities as unsupported or unverified, so production
provider dispatch remains disabled.

GitHub CLI authentication is present for account `Rohan0603` with repository
scopes, but the token lacks `read:project`; no disposable Project/PR target is
configured. No remote writes were attempted.

## Live disposable GitHub and CodeRabbit qualification

GitHub CLI authentication was refreshed during the current qualification with
scopes `read:project`, `repo`, and `workflow`. Project #1 was inspected and
contains unrelated JEV-IMRP items, so it was not modified. Creating a separate
Project was attempted and refused because the token lacks write `project`
scope.

The explicitly disposable repository
`Rohan0603/Generating-quiz-file` was inspected and confirmed public,
non-fork, unarchived, with default branch `main`. The following scoped writes
were performed:

- created issue #2 for qualification;
- imported issue #2 through the live `GitHubApiClient` and persisted it into a
  temporary SQLite database;
- repeated import was idempotent (`imported` then `synced`);
- synchronized status/progress through the live client (`syncState=synced`);
- created branch `orchestrator-qualification`, commit
  `fdc2297d529769f1649628b05fa52f2403adf25d`, and open PR #3;
- no merge was performed.

## Live disposable GitHub Projects v2 qualification — 2026-10-19

Authentication was rechecked with `gh auth status`; account `Rohan0603`
reported `gist`, `project`, `read:org`, `repo`, and `workflow` scopes.
Project #1 (`@Rohan0603's untitled project`, `PVT_kwHOBcLAlM4BndwY`) was
inspected and not modified because it contains unrelated items.

A dedicated private disposable Project was created:

- Project #2: `Orchestrator disposable qualification 2026-10-19`
- Node ID: `PVT_kwHOBcLAlM4BnpKz`
- URL: `https://github.com/users/Rohan0603/projects/2`

Issue #2 from `Rohan0603/Generating-quiz-file` was added as item
`PVTI_lAHOBcLAlM4BnpKzzhBqo5E`. Live item listing returned the issue and its
initial `Todo` status. The live `Status` field was then changed to `In
Progress` with `gh project item-edit`; a subsequent item listing returned
`status: In Progress`.

The Orchestrator `GitHubApiClient.listProjectItems` and
`listProjectFields` methods were run against Project #2 with the authenticated
token and returned the project item, issue number, Status field, and option
IDs. The Orchestrator `updateProjectSingleSelect` method then changed the
item from `In Progress` to `Todo`, and back to `In Progress`; `gh project
item-list` read back both changes. Empty identifiers were rejected locally and
an invalid option was rejected without a confirmed mutation. This proves live
Projects v2 creation, issue item creation, field discovery, field mutation,
read-back, and Orchestrator-owned write-path behavior. Durable issue/task
import and status/progress synchronization remain covered by the live issue
flow above.

Commands and results:

| Command | Exit | Result |
|---|---:|---|
| `gh auth status` | 0 | Required scopes present |
| `gh project list --owner Rohan0603` | 0 | Project #1 and dedicated Project #2 visible |
| `gh project create --owner Rohan0603 --title "Orchestrator disposable qualification 2026-10-19"` | 0 | Project #2 created |
| `gh project item-add 2 --owner Rohan0603 --url .../issues/2` | 0 | Issue #2 added |
| `gh project item-edit 2 --owner Rohan0603 --url .../issues/2 --field Status --value "In Progress"` | 0 | Status field updated |
| `gh project item-list 2 --owner Rohan0603 --limit 100 --format json` | 0 | Item returned with `status: In Progress` |
| `node --input-type=module -e "...GitHubApiClient.listProjectItems(...)"` | 0 | Orchestrator client returned item ID and issue #2 |
| `node --input-type=module -e "...GitHubApiClient.listProjectFields(...); updateProjectSingleSelect(...)"` | 0 | Orchestrator changed `In Progress → Todo`; CLI read-back returned `Todo` |
| `node --input-type=module -e "...updateProjectSingleSelect(...In Progress...)"` | 0 | Orchestrator changed `Todo → In Progress`; CLI read-back returned `In Progress` |
| `node --input-type=module -e "...empty/invalid option..."` | 0 | Empty IDs and invalid option rejected |

OpenCode native ownership/cancellation remains blocked. The live adapter
continues to advertise `cancellation.request=unsupported` and
`cancellation.ownership=unverified`; route evaluation therefore refuses
production dispatch. The adapter's cancellation implementation is wired to
the native coordinator but remains unexercised with a real provider. No
production OpenCode dispatch or cancellation was enabled, and no claim of
qualified native ownership was made.

The first live API attempt found and fixed a real defect: repository paths were
encoded as one `%2F` segment, producing GitHub REST 404 responses. Shared
owner/name path validation now encodes each path segment separately in
`src/integrations/github.ts` and `src/integrations/coderabbit.ts`.

PR #3 has a confirmed live CodeRabbit review comment and run ID
`cc4a52d9-5714-465e-adc5-186145ece553`. The existing CodeRabbit adapter detected
the review with `source=live`, `pullRequestNumber=3`, and two live comments.
Review reported no actionable comments and minimal merge risk. No repair or
merge was performed because the disposable PR contained no code defect and
production merge remains separately gated.

Project item synchronization was qualified against disposable Project #2.
Unrelated Project #1 was left untouched.

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

- `npm test`: exit 0, 54/54 test cases.
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

## Qualification refresh — 2026-10-19

This refresh preserved the existing dirty primary checkout and made no source
changes.

| Command / procedure | Exit | Result | Evidence boundary |
|---|---:|---|---|
| `npm test` | 0 | PASS; all configured groups passed (51 Electron tests plus 3 runner regression tests) | Electron/local; fixture and integration tests |
| `npm exec tsc -- --noEmit` | 0 | PASS | Local typecheck |
| `npm run build` | 0 | PASS | Local production build |
| `npm run build:native-helper` | 0 | PASS | Native helper compilation |
| `npm audit --json` | 0 | PASS; zero reported vulnerabilities | Installed dependency tree |
| `git diff --check` | 0 | PASS | Existing dirty worktree preserved |
| `npm run package:win` | 0 | PASS; `out\Orchestrator-win32-x64` created | Windows package generation |
| Packaged app launch with `--disable-gpu`, 5-second wait, explicit parent-PID shutdown | 0 | PASS | Packaged startup/parent shutdown only |

The packaged live-provider route was not exercised. The current helper launch
protocol supports fixture launch and an executable path, but does not yet
provide a validated command-line argument, working-directory/environment,
stdout/stderr transport, and provider-session lifecycle contract for OpenCode.
`OpenCodeCliAdapter` therefore continues to report cancellation ownership as
unsupported/unverified, while its cancellation method attempts coordinator
cleanup when invoked. Production live-worker dispatch remains disabled.

Current verdict remains **PARTIAL / BLOCKED for production worker
qualification**, while local integrity, fixture ownership, persistence,
renderer security, and fail-closed recovery gates remain supported by the
tests above.

## Packaged startup qualification refresh — 2026-10-19

The unsigned package was rebuilt with `npm run package:win` after releasing an
exact checkout-owned native-helper process that held the output binary open.
The rebuild exited `0` and produced `out\Orchestrator-win32-x64`.

The packaged executable was launched with `--disable-gpu` and an isolated
temporary `--user-data-dir`. It remained running for five seconds, then was
stopped through its exact child PID. The process exited and no packaged
`job-object-helper.exe` remained.

This qualifies packaged startup and controlled parent shutdown only. No
interrupted packaged ownership record was injected, so packaged restart
reattachment and cleanup remain unqualified.

## Packaged restart recovery qualification — 2026-10-19

A disposable Electron test runner seeded SQLite ownership state for a worker
owned by a detached native helper. The helper input was closed to simulate
application interruption while retaining the named Job Object. Packaged
Electron then started against the same isolated user-data directory.

Observed durable result:

```text
ownership.state=cleanup_verified
ownership.cleanup_verified=1
ownership.last_status=restart_reconciled
runs.recovery_state=reconciled
```

The packaged app remained alive during the eight-second trial, then was
stopped through its exact child PID. The query runner passed and no
checkout-owned helper remained. This qualifies packaged restart reattachment
and cleanup for the controlled fixture worker. It does not qualify real
OpenCode cancellation, real-provider restart recovery, or independent review.
Reproduction command: `node experiments/runners/run-packaged-restart.mjs`.
Machine-readable result: `experiments/results/packaged-restart-1792405361112.json`.

## Native provider protocol checkpoint — 2026-10-19

Implemented and tested a bounded generic owned-process protocol. The helper now
accepts structured arguments, absolute executable and working-directory
requirements, bounded environment entries, and launches suspended before Job
Object assignment and membership verification. It transports correlated
stdout/stderr events, reports provider exit status, and preserves verified
termination semantics.

`OpenCodeCliAdapter` no longer directly spawns a provider. It routes launch and
cancellation through `NativeOwnershipCoordinator`; owner loss remains
inconclusive and cleanup uncertainty remains unverified. Capability manifest
states remain conservative until an independent reviewer and real-provider
vertical slice qualify them.

Additional checks:

| Command / procedure | Exit | Result |
|---|---:|---|
| `npm run build:native-helper` | 0 | PASS |
| `npm exec tsc -- --noEmit` | 0 | PASS |
| `npm exec tsc -- -p tsconfig.test.json` | 0 | PASS |
| `npm test` | 0 | PASS; all configured suites, including 10 native-ownership tests |

Review package: [docs/REAL_PROVIDER_REVIEW_PACKAGE.md](./REAL_PROVIDER_REVIEW_PACKAGE.md).
This is an implementation checkpoint, not independent review or production
provider qualification.

## Disposable OpenCode slice attempt — 2026-10-19

The locally installed native OpenCode executable was found at
`C:\Users\ponna\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe`.
An Electron-hosted disposable slice was attempted through the new owned adapter
path against a temporary workspace and SQLite database. The test exited
non-zero after provider launch; no artifact proof or successful terminal
evidence was produced. This is recorded as **failed/inconclusive**, not as live
provider qualification. The temporary test and workspace were removed.

A direct Node-hosted attempt was not used as evidence because the installed
`better-sqlite3` binary targets a different Node ABI (`NODE_MODULE_VERSION
149` vs host `137`); Electron-hosted tests remain the authoritative local
runtime.

## Post-remediation validation — 2026-10-19

After evidence-backed acceptance and qualification-runner hardening:

| Command | Exit | Result |
|---|---:|---|
| `npm exec tsc -- --noEmit` | 0 | PASS |
| `npm exec tsc -- -p tsconfig.test.json` | 0 | PASS |
| `npm test` | 0 | PASS; all configured suites |
| `npm run build` | 0 | PASS |
| `git diff --check` | 0 | PASS |

Acceptance now derives criteria, deterministic-check, and completeness inputs
from acceptable durable evidence records joined to dispatch correlation. Missing
evidence blocks before criteria/check evaluation; independent review remains
blocked unless a genuine reviewer result exists.

OpenCode qualification runners now derive capability and prerequisite flags from
the adapter manifest and report cancellation capability from that manifest
instead of asserting qualification values. This does not qualify live-provider
ownership, cancellation, packaged-provider behavior, or independent review.

Latest post-hardening validation also passed:

| Command | Exit | Result |
|---|---:|---|
| `npm run build:native-helper` | 0 | PASS |
| `node scripts/run-electron-tests.mjs --expected=8 dist-test/tests/native-ownership.test.js` | 0 | 8/8 PASS |
| `node scripts/run-electron-tests.mjs --expected=10 dist-test/tests/sqlite-runtime.test.js` | 0 | 10/10 PASS |
| `npm test` | 0 | 54/54 test cases PASS |
| `npm run build` | 0 | PASS |
| `git diff --check` | 0 | PASS |

These results do not close the remaining gates. Real-provider cancellation and
descendant containment, restart ownership recovery, packaged/clean-machine
qualification, signing/install evidence, and independent review remain
unqualified. The native unknown-process-count fail-closed path now has deterministic
regression coverage through its shared response validator.

OpenCode route identity is now derived inside the adapter from validated
`provider/model` input. Qualification runners consume that adapter-owned
identity instead of constructing provider and model identity independently.

Run state transitions now append their audit event inside the same SQLite
transaction as the state update, preventing durable state/audit divergence on
audit failure.
