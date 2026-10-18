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
| CR-04 | Policy, risk, exact approval / Critical | Deterministic unit/integration cases for decisions, expiry, context changes, one-shot consumption, persistence failure | Fail closed; no mismatched, expired, consumed, or prohibited action proceeds | Pure policy/approval cases pass; persistence-error and transactional consumption tests blocked by native SQLite readiness | P0.2 record below | implemented-not-validated | `ad8e663` / `0.1.0` | Run SQLite-backed transaction and failure tests after native readiness |
| CR-05 | Dispatch idempotency and evidence provenance / Critical | Deterministic dispatch/event/evidence cases plus persistence failure cases | Duplicate or uncertain dispatch is blocked; invalid evidence cannot satisfy acceptance | Pure route/progress/evidence cases pass; durable idempotency and cursor tests blocked by native SQLite readiness | P0.2 record below | implemented-not-validated | `ad8e663` / `0.1.0` | Run SQLite-backed dispatch and evidence tests after native readiness |
| CR-06 | Harness capability and route identity / Critical | Authorized adapter conformance trials against every mandatory capability | Mandatory gaps block; provider/model identity and fallback are explicit | No adapter integrated or exercised | None | blocked | `7edc5d2` / `0.1.0` | Qualify candidate only after conformance evidence |
| CR-07 | Cancellation, deadlines, restart, recovery / Critical | Authorized fault, process-ownership, restart, timeout, disk/persistence failure exercises | Unknown state remains recovery-required; unsafe redispatch is prevented | Not implemented/validated end-to-end | None | blocked | `7edc5d2` / `0.1.0` | Implement remaining lifecycle/recovery behavior, then exercise |
| CR-08 | Dependency, licensing, packaging, installation / High | `npm ls`; `npm audit --json`; package license metadata; native artifact inspection; clean Windows install | Dependencies acceptable; install/startup reproducible; no unsafe scripts/config | MIT/Apache direct licenses recorded; 2 high and 4 moderate vulnerabilities; Electron and SQLite native binaries absent; packaging not run | P0-D record below | blocked | `7edc5d2` / `0.1.0` | Do not upgrade/remediate without authorization; resolve native install and audit gates |
| CR-09 | Regression and release qualification / High | Repeatable deterministic suite, release checklist, clean-machine rerun | Required suite passes at pinned commit; failures retained and triaged | Nine pure deterministic tests pass; clean-machine, runtime, packaging, and release qualification remain unvalidated | P0.2 record below | implemented-not-validated | `ad8e663` / `0.1.0` | Expand after native readiness; run clean-machine release qualification |
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

## P0.2 deterministic test and dependency record

P0.2 tests and metadata inspection ran locally against test checkpoint
`ad8e663` with no package changes, native install-script enablement, startup,
provider call, recovery exercise, or destructive security exercise.

### Prioritized deterministic test plan

| Priority / risk | Observable case | Expected result | Evidence |
|---|---|---|---|
| P0 / Critical | Valid and terminal run-state transitions | Valid transition succeeds; terminal escape throws | `tests/deterministic.test.ts` lifecycle test |
| P0 / Critical | Malformed, prohibited, missing-capability, and incomplete-evidence policy inputs | Invalid input blocks; prohibited action denies; missing prerequisites block | Policy test assertions |
| P0 / Critical | Exact approval context, policy version, expiry, and consumed state | Mismatch, policy change, expiry, and reuse reject | Approval test assertions |
| P0 / Critical | Missing and unsatisfied conditional route capabilities | Mandatory gaps block; missing manifest entry is unverified | Route test assertions |
| P0 / Critical | Adapter-reported route identity | Known adapter identity permits route; orchestrator-reported identity blocks | Route identity test assertions |
| P0 / Critical | Duplicate, out-of-order, and correlation-mismatched progress | Duplicate/out-of-order events reject; mismatched events quarantine | Progress test assertions |
| P0 / Critical | Evidence provenance, completeness, and independent verification | Only complete orchestrator-verified evidence is acceptable | Evidence test assertions |
| P0 / Critical | SQLite transaction rollback and persistence failures | Failed transaction leaves no partial success; errors remain explicit | **Blocked** until native SQLite runtime is restored; no mock claimed as proof |

### Executed test result

| Command | Actual result | Status | Evidence |
|---|---|---|---|
| `npm test` | TypeScript test compilation passed; Node test runner passed 9/9 tests, 0 failed | **PASS** for pure deterministic contracts | `tests/deterministic.test.ts`; no coverage report generated |

Pure tests do not establish SQLite persistence, Electron runtime security,
recovery, packaging, clean-machine reproducibility, or adapter compatibility.

### Dependency audit investigation

Installed direct versions remain `better-sqlite3@12.11.1`,
`electron@38.8.6`, and `typescript@5.9.3`. `npm audit --json` reports
0 critical, 2 high, 4 moderate, 0 low, and 0 info findings across 106
dependencies.

| Package/path | Severity | Finding or dependency path | Suggested fix | Compatibility assessment |
|---|---|---|---|---|
| `electron` | High | Electron security advisories through current Electron tree | `electron@44.9.0` | Major upgrade; Electron 44 requires Node `>=22.12.0`; requires separate compatibility, packaging, and security validation |
| `extract-zip` via `electron` | High | Symlink path traversal/arbitrary archive write advisories | Electron `44.9.0` | Transitive fix coupled to major Electron upgrade; no isolated upgrade performed |
| `@electron/get` via `global-agent` | Moderate | Vulnerable `global-agent` range | Electron `44.9.0` | Transitive fix coupled to major Electron upgrade |
| `global-agent` via `roarr` | Moderate | Vulnerable `global-agent` range | Electron `44.9.0` | Transitive fix coupled to major Electron upgrade |
| `roarr` via `sprintf-js` | Moderate | Vulnerable `roarr` range | Electron `44.9.0` | Transitive fix coupled to major Electron upgrade |
| `sprintf-js` | Moderate | Unbounded precision denial of service | Electron `44.9.0` | Transitive fix coupled to major Electron upgrade |

`npm audit fix --force` was not run. No package was upgraded, removed, or
reinstalled. Direct package licenses remain Electron MIT, better-sqlite3 MIT,
and TypeScript Apache-2.0; full transitive license inventory remains
outstanding.

### Native readiness investigation

`npm config get ignore-scripts` returned `false`, so npm project config does
not intentionally disable scripts. Package metadata declares Electron
`postinstall: node install.js` and better-sqlite3
`install: prebuild-install || node-gyp rebuild --release`. The current
environment previously blocked these native install scripts. Current checks
still find no `node_modules\electron\dist\electron.exe` and no
better-sqlite3 `.node` binary.

Proposed remediation, not executed: obtain explicit environment authorization
for native install scripts, run a clean dependency installation in an approved
Windows environment, verify Electron executable and better-sqlite3 binary
presence, then run separate SQLite and Electron runtime gates. Do not enable
scripts or change environment policy as part of this checkpoint.

## P0.3 native runtime readiness assessment

Assessment started from clean `master` at
`b9985ff33dbb471706b13fe33d158a2a43893c9f`, three commits ahead of
`origin/master` at `7edc5d251d2022e202f748e83d7818057c7a10b7`. No source,
dependency, configuration, remote, or environment-policy change was made
during assessment.

### Executed checks

| Check | Result | Evidence and limit |
|---|---|---|
| `npm test` | **PASS** — 9/9, 0 failed | Pure deterministic contracts only; no SQLite or Electron runtime |
| `npm exec tsc -- --noEmit` | **PASS** — exit 0 | Type safety only; no runtime proof |
| `npm config get ignore-scripts` | **UNVERIFIED for execution** — returned `false` | Setting permits scripts; it does not prove scripts ran |
| Installed package inspection | **PASS** — versions and scripts recorded | Electron 38.8.6; better-sqlite3 12.11.1; no install action |
| `node_modules\electron\dist\electron.exe` | **BLOCKED** — absent | Electron cannot launch from current installation |
| better-sqlite3 `.node` binary | **BLOCKED** — none found | SQLite repositories cannot open native database binding |
| `npm audit --json` | **FAIL/BLOCKED** — 2 high, 4 moderate | Findings inspected only; no fix command ran |

### Native blocker separation

Electron needs its `postinstall: node install.js` step to obtain its packaged
runtime executable. That executable is absent, so `npm start` cannot launch
the application. better-sqlite3 needs
`install: prebuild-install || node-gyp rebuild --release` to obtain a
platform-specific native binding. That binding is absent, so `openDatabase`
and repository transaction tests cannot run.

Both blockers share one confirmed symptom: native install outputs are absent.
They do not share one runtime artifact or one proof requirement. Electron
readiness requires an executable and safe Electron startup checks.
better-sqlite3 readiness requires a loadable `.node` binding and SQLite
migration/transaction checks. `ignore-scripts=false` is only configuration
evidence, not execution evidence. The prior environment restriction blocking
native install scripts remains the documented cause; this assessment did not
re-enable or bypass it.

Evidence required to close each blocker:

1. Electron: approved clean Windows install or equivalent approved
   preparation, executable presence, package integrity, then authorized
   startup/security checks.
2. better-sqlite3: approved native install or build, loadable binding
   presence, then authorized fresh/upgrade migration, rollback, and
   persistence-failure checks.

Any clean install or rebuild would execute third-party package scripts and
may download binaries. Electron 44.9.0 would also change dependency major
version and requires Node `>=22.12.0`; both actions need separate explicit
authorization. Rollback means restore the lockfile/package manifest and
recreate dependencies in an approved clean environment; no rollback action
was needed because no remediation ran.

### Audit identifiers and compatibility

Confirmed audit advisory identifiers include Electron advisories
`1116060`, `1116111`, `1116259`, `1116320`, `1136551`, `1136552`, `1136559`,
`1136560`, `1136567`, `1136571`, `1136575`, `1136579`, `1136590`, `1136597`,
`1136607`, `1136634`, `1136647`, `1136651`, `1136659`, `1239973`, `1239977`,
`1239981`, `1240060`, and `1241657`; extract-zip advisories `1139346` and
`1193685`; and sprintf-js advisory `1241202`. Current vulnerable ranges and
package paths remain recorded in P0.2 above. npm reports Electron
`44.9.0` as fix, with a major-version change. No isolated transitive upgrade
was confirmed.

### Deterministic test quality review

The nine tests assert observable contract outcomes: accepted and rejected
lifecycle transitions, fail-closed policy decisions, approval binding and
rejection reasons, capability and identity route decisions, progress
quarantine/order handling, and evidence acceptance. They do not assert
private implementation details. The tests substantiate pure-contract claims
in CR-04, CR-05, and CR-09, but do not substantiate SQLite, Electron,
recovery, packaging, or adapter compatibility claims.

Important untested branches remain: `createApprovalRequest` validation,
`evaluateDispatchEligibility`, dispatch-record authorization matching,
terminal-outcome classification, workspace branch checks, audit-chain
persistence, migration versioning/rollback, repository error wrapping, IPC
runtime sender checks, CSP enforcement, cancellation, deadlines, and
restart reconciliation. Persistence tests are **BLOCKED**, not replaced with
mocks.

### P0.3 remediation decision package

| Priority | Action | Prerequisite and authorization | Security/compatibility risk | Validation and rollback |
|---|---|---|---|---|
| P0 | Restore approved native installation outputs | Explicit authorization to execute npm install scripts or approved clean-machine preparation | Third-party scripts and binary downloads execute; supply-chain and platform risk | Verify hashes/paths, then run SQLite/Electron gates; recreate clean dependency state if failed |
| P0 | Run SQLite runtime qualification | Native better-sqlite3 readiness plus explicit runtime-test authorization | Persistence failure could expose partial state | Fresh/upgraded migration, rollback, and injected failure checks; remove only disposable test DBs |
| P0 | Run Electron boundary qualification | Native Electron readiness plus explicit application-start authorization | Launches privileged desktop process | Startup flags, CSP, IPC sender/payload checks; stop process after checks |
| P1 | Assess Electron security upgrade | Separate dependency-change authorization and Node compatibility decision | Major Electron behavior/API, packaging, and security regression risk | Branch/lockfile review, build, startup/security regression; revert manifest/lockfile if rejected |
| P1 | Complete transitive license inventory | Tooling/metadata inspection authorization | License obligations may affect redistribution | Produce package/version/license/source report tied to lockfile; no code rollback needed |

P0.3 status: deterministic pure tests and type check **PASS**; native
runtime readiness **BLOCKED**; dependency audit **FAIL/BLOCKED**; SQLite and
Electron runtime qualification **NOT RUN**; clean-machine reproducibility,
coverage, recovery, packaging, adapter qualification, and independent review
**UNVERIFIED/BLOCKED**.

## P0.4 controlled native runtime setup plan

This section is a plan only. It records no completed native setup or runtime
validation. During P0.4 planning, no install, rebuild, upgrade, application
launch, binary download, environment-policy change, or lockfile change ran.

### Gates and authorization

| Gate | Scope | Required authorization | Pass evidence |
|---|---|---|---|
| Native setup | Execute existing Electron and better-sqlite3 install/build scripts without changing versions | Explicit approval for third-party script execution and possible binary downloads | Expected native artifacts exist and load |
| SQLite validation | Open disposable real SQLite DB; run migrations, transactions, repositories, and failure cases | Explicit approval for native runtime tests and disposable DB creation/deletion | Test report with fresh/upgrade/rollback/error evidence |
| Electron validation | Start Electron app and inspect startup/security boundaries | Explicit approval to launch application and controlled process cleanup | Startup log plus security probe results |
| Dependency remediation | Change Electron or transitive dependency versions | Separate explicit dependency-change approval | Reviewed manifest/lockfile, audit rerun, build and regression evidence |
| Packaging | Produce installer/package artifacts | Separate packaging and generated-artifact approval | Reproducible package, install/startup evidence, clean-machine result |
| Commercial readiness | Interpret all hard gates and independent review | Product-release authorization; independent review still required | Evidence-linked report; no blocked critical gates |

P0.4 native setup must not silently enable scripts globally, modify npm
configuration, upgrade dependencies, or claim that native setup is complete
because npm reports `ignore-scripts=false`.

### Pre-change evidence capture

Run from `C:\Users\ponna\Project\Orchestrator` before any authorized setup:

```powershell
git status --short
git status --branch --short
git rev-parse HEAD
git rev-parse origin/master
git diff --check
git config --local user.name
git config --local user.email
node --version
npm --version
npm config get ignore-scripts
npm ls electron better-sqlite3 typescript --depth=0
Get-FileHash package.json,package-lock.json -Algorithm SHA256
Test-Path node_modules\electron\dist\electron.exe
Get-ChildItem node_modules\better-sqlite3 -Recurse -Filter *.node
cmd.exe /d /c "npm audit --json > audit-before.json"
```

`npm audit` may exit nonzero when findings exist; preserve its JSON output as
evidence, not as a remediation failure. Store evidence outside Git or in an
explicitly approved evidence directory. Do not commit native binaries,
databases, audit dumps, or generated output.

### Backup and rollback

Before setup, copy `package.json`, `package-lock.json`, and the pre-change
evidence manifest to a timestamped directory outside the repository. Record
the current commit and SHA-256 hashes. Do not copy `node_modules` as a source
of truth.

If setup changes tracked files, stop. Review the diff before any next action.
Rollback by restoring only the reviewed manifest/lockfile copies, removing the
disposable `node_modules` tree in an approved environment, and recreating
dependencies through an separately authorized clean-install procedure. Do not
use `git reset`, history rewriting, or force-push. If setup fails without
tracked-file changes, preserve logs and native artifact state; do not retry
with broader permissions or alternate versions without new approval.

### Minimum native setup

Keep current manifest and lockfile unchanged. After explicit approval for
script execution and possible downloads, run each package separately so
failure ownership stays clear:

```powershell
npm rebuild electron --foreground-scripts
npm rebuild better-sqlite3 --foreground-scripts
```

Both commands can execute third-party scripts. Electron may download its
platform runtime. better-sqlite3 may download a prebuild or invoke `node-gyp`
and local compiler tooling. No `npm install`, `npm ci`, `npm audit fix`,
version change, or global npm policy change is part of minimum setup.

Immediately after each command, capture:

```powershell
Test-Path node_modules\electron\dist\electron.exe
Get-ChildItem node_modules\better-sqlite3 -Recurse -Filter *.node
Get-FileHash package.json,package-lock.json -Algorithm SHA256
git status --short
```

Stop if a script requests unexpected network access, changes tracked files,
reports an unsupported Node/ABI/compiler condition, or produces an artifact
outside expected package paths. Preserve command output and error text.

### SQLite validation after native setup

Add real native tests in `tests/sqlite-runtime.test.ts`; do not mock
`better-sqlite3` or replace repository calls with fakes. Use disposable
temporary database paths and remove only those test files after each test.
Keep test data deterministic.

Required cases:

1. Fresh `openDatabase` creates schema version 3, enables foreign keys, and
   exposes all migration tables.
2. A database seeded at schema version 1 advances through migrations 2 and 3
   without losing task, run, attempt, approval, or audit rows.
3. A migration failure inside a transaction leaves schema version and partial
   tables unchanged.
4. A transaction that inserts then throws leaves no partial row.
5. `TaskRepository` create/list round-trips durable task fields.
6. `PolicyRepository` records decision and audit event atomically; approval
   consumption is exact-context, single-use, and audited.
7. `DispatchRepository` enforces durable unique dispatch/idempotency keys,
   cursor/event persistence, and evidence writes.
8. Closed/read-only/corrupt database conditions return explicit
   `PersistenceError` without success-shaped fallback.

Proposed command after test implementation and native setup:

```powershell
npm test
npm exec tsc -- --noEmit
```

Record test count, failures, database paths, schema versions, and retained
error evidence. A passing pure suite cannot close CR-02, CR-04, or CR-05.

### Electron validation after native setup

Do not use `--no-sandbox`, disable context isolation, enable Node integration,
weaken CSP, or add debug exceptions. Start only after native setup evidence:

```powershell
npm start
```

Controlled validation must verify:

1. Electron starts from `dist/main/main.js` and reports no missing executable
   or preload/asset error.
2. `BrowserWindow` uses `contextIsolation: true`, `sandbox: true`, and
   `nodeIntegration: false`; preload path resolves inside expected build
   output.
3. Renderer cannot access Node/process/fs APIs and receives only typed preload
   methods.
4. Renderer CSP rejects unexpected script/resource origins.
5. IPC rejects messages from a non-active or foreign sender and rejects
   malformed payloads.
6. Renderer cannot open unapproved windows or navigate outside allowed local
   content.
7. Main-process database initialization fails explicitly when persistence
   setup is unavailable.

Capture startup logs and probe results. Close only the controlled test
processes after checks. These checks establish Electron runtime evidence but
do not constitute independent security review.

### Separate remediation and release sequence

1. Native setup gate: execute approved rebuilds, verify artifacts, preserve
   hashes, stop on unexpected side effects.
2. SQLite gate: run real native migration/transaction/repository tests; keep
   CR-02/04/05 blocked on any failure or inconclusive result.
3. Electron gate: run controlled startup and boundary probes; keep CR-03
   implemented-not-validated until runtime evidence is retained.
4. Dependency gate: only after separate approval, evaluate Electron upgrade
   compatibility; update manifest/lockfile in its own reviewed commit and
   rerun audit/build/tests.
5. Packaging gate: separately authorize packaging, test clean Windows
   installation, verify artifact hashes and uninstall behavior.
6. Commercial gate: require all applicable evidence, unresolved-defect review,
   security limitations, dependency/license report, recovery evidence, and
   genuine independent review. No marketplace recommendation before then.

### Exact next-stage commands and side effects

These commands are proposed, not executed:

```powershell
git status --short
git rev-parse HEAD
Get-FileHash package.json,package-lock.json -Algorithm SHA256
npm config get ignore-scripts
npm ls electron better-sqlite3 typescript --depth=0
npm rebuild electron --foreground-scripts
npm rebuild better-sqlite3 --foreground-scripts
Test-Path node_modules\electron\dist\electron.exe
Get-ChildItem node_modules\better-sqlite3 -Recurse -Filter *.node
npm test
npm exec tsc -- --noEmit
npm start
```

`npm rebuild` executes package scripts and may download or compile native
code. `npm test` creates disposable test databases only after native SQLite
tests are added. `npm start` launches the Electron application and creates
desktop/runtime side effects. The final command requires controlled process
cleanup and runtime evidence. Execute none of these in planning stage.

Required approval before execution: explicit authorization for third-party
install-script execution and possible binary downloads; explicit
authorization for native SQLite runtime tests and disposable database
creation; explicit authorization to launch and close Electron; and separate
approval for any dependency, environment-policy, packaging, or remote change.

## P0.5 native setup and runtime validation record

P0.5 began from `84bd2071d087d5b46585e10dbcedea30f23b9cf9`. At start,
`master` and `origin/master` were both at that commit with a clean worktree.
This contradicted the prior P0.4 report that local branch was ahead by five;
current Git state is authoritative. Node was `v24.19.0`, npm `12.0.2`, and
direct packages remained Electron `38.8.6`, better-sqlite3 `12.11.1`, and
TypeScript `5.9.3`.

Baseline manifest hashes and copies were captured outside the repository at
the session evidence path `p05-baseline-20261018-1550`. No secrets or
`node_modules` copy was made.

### Native setup result

The authorized commands were attempted without changing npm policy:

```text
npm rebuild electron --foreground-scripts
npm rebuild better-sqlite3 --foreground-scripts
```

Both commands returned exit code 0 but emitted:

```text
npm warn rebuild 2 packages had install scripts blocked because they are not covered by allowScripts.
```

Read-only policy inspection identified the exact blocked scripts:

```text
better-sqlite3@12.11.1 (install: node-gyp rebuild)
electron@38.8.6 (postinstall: node install.js)
```

`npm config get ignore-scripts` returned `false`, but npm's separate
`allowScripts` policy still blocked both scripts. `npm install-scripts ls`
recommended `npm install-scripts approve`; that would change environment
security policy and was not run. No script-policy bypass or approval was
authorized under this stage's constraints.

Artifact checks remain:

| Artifact | Result | Status |
|---|---|---|
| `node_modules\electron\dist\electron.exe` | Absent | **BLOCKED** |
| better-sqlite3 `.node` native binding | None found | **BLOCKED** |
| `package.json` / `package-lock.json` | Unchanged; worktree clean after setup attempts | **PASS** for no tracked dependency change |

Because native outputs remain absent, no Electron process was launched and no
real SQLite database was opened. SQLite runtime, Electron runtime-security,
packaging, and native ABI validation are **NOT RUN**.

Safe checks rerun after the blocked setup attempts: `npm test` passed 9/9
pure tests, and `npm exec tsc -- --noEmit` passed. These results do not change
the native runtime gate.

### Dependency audit result

Fresh non-remediating `npm audit --json` still reports 0 critical, 2 high,
4 moderate, 0 low, and 0 info findings. Vulnerable paths are `electron`,
`extract-zip`, `@electron/get`, `global-agent`, `roarr`, and `sprintf-js`.
Audit metadata still proposes Electron `44.9.0` as a major-version fix.
No dependency upgrade, `npm audit fix`, install, or lockfile edit ran.

Dependency remediation is therefore a separate **BLOCKED** gate. Before any
upgrade, obtain explicit dependency-change authorization, review Electron
breaking changes and Node/Electron/native ABI compatibility, update manifest
and lockfile together, rebuild native modules under approved script policy,
then rerun audit, typecheck, deterministic tests, SQLite, Electron, and
packaging validation. If native setup cannot be authorized, leave the
vulnerable dependency set unchanged and report the release block.

### P0.5 status and next authorization

| Gate | Status | Reason |
|---|---|---|
| Baseline and rollback evidence | **PASS** | Clean synchronized Git state and manifest backup captured |
| Native setup | **BLOCKED** | npm `allowScripts` policy blocks required package scripts |
| SQLite runtime validation | **NOT RUN** | better-sqlite3 binding absent |
| Electron runtime validation | **NOT RUN** | Electron executable absent |
| Dependency remediation | **BLOCKED** | Major fix requires separate compatibility and dependency authorization |
| Packaging | **NOT RUN** | Native runtime unavailable and packaging not authorized |
| Commercial readiness | **BLOCKED** | Critical runtime, persistence, recovery, adapter, and independent-review gates remain open |

Required next authorization is explicit approval from the authority that
controls npm `allowScripts` for these exact packages, or an approved clean
Windows environment where package scripts may execute without bypassing
policy. That approval must be separate from dependency-upgrade approval.
After native setup, authorize SQLite runtime tests and Electron startup/security
checks as separate gates. Do not run `npm install-scripts approve` without
that policy-owner authorization.

### P0.5 continuation after explicit script approval

The user then explicitly approved only the following package scripts:
`electron@38.8.6` (`postinstall: node install.js`) and
`better-sqlite3@12.11.1` (`install: node-gyp rebuild`). npm 12.0.2 documented
scoped syntax:

```text
npm install-scripts approve <pkg> [<pkg> ...]
```

The exact pinned command ran:

```text
npm install-scripts approve electron@38.8.6 better-sqlite3@12.11.1 --allow-scripts-pin
```

This wrote package-scoped `allowScripts` entries. No `--all` approval ran.
The approved rebuilds executed and produced Electron 38.8.6's executable and
a Node 24 better-sqlite3 binding. Direct Node load passed. Electron launch then
failed closed because Electron 38 required ABI `139` while the binding was
compiled for Node ABI `137`:

```text
This version of Node.js requires NODE_MODULE_VERSION 139.
```

An Electron-targeted rebuild was attempted. npm 12 rejected direct
`--runtime/--target/--dist-url` flags, so equivalent environment variables
were used for the package script. Electron 38 startup remained ABI-incompatible
until dependency remediation was assessed.

### Electron 44 dependency remediation result

Live metadata confirmed Electron `44.9.0` as the audit fix, with Node
`>=22.12.0`; current Node `v24.19.0` satisfies that engine. Source review
found only stable Electron APIs (`app`, `BrowserWindow`, `dialog`, `ipcMain`,
`contextBridge`) and no known Electron-38-specific API usage. better-sqlite3
12.11.1 supports Node 24, but still requires an Electron-ABI native rebuild.

After rollback backup capture, scoped remediation changed Electron from
`^38.2.2` to `^44.9.0` and updated `package-lock.json` through:

```text
npm install electron@44.9.0 --save-dev --foreground-scripts
```

The audit then reported **0 vulnerabilities**: 0 critical, 0 high, 0
moderate, 0 low, 0 info. This is dependency-audit evidence only, not runtime
qualification.

The required Electron-44 SQLite rebuild was attempted with:

```text
npm rebuild better-sqlite3 --foreground-scripts
```

using Electron-target environment values. No Electron-44 prebuilt binding
was available. `node-gyp` downloaded Electron headers, then failed because
Visual Studio with Desktop development with C++ was unavailable. The exact
failure was `Could not find any Visual Studio installation to use`.
No compiler or system toolchain was installed.

Current post-upgrade artifacts: Electron executable absent and no
better-sqlite3 `.node` binding. The dependency upgrade is applied but
runtime-unverified and cannot close CR-08 or CR-03. Rollback remains available
from the pre-upgrade manifest/lockfile backup; do not roll back silently.

### Executed post-upgrade evidence

| Check | Result | Status |
|---|---|---|
| `npm test` before Electron upgrade | 14/14 pure and real SQLite tests passed | **PASS** for Electron-38/Node-24 SQLite only; not Electron ABI proof |
| `npm test` after Electron upgrade | 9 pure tests passed; 5 SQLite tests failed with missing native binding | **FAIL/BLOCKED** |
| `npm run build` | Exit 0 | **PASS** build only |
| `npm exec tsc -- --noEmit` | Exit 0 | **PASS** typecheck only |
| `npm audit --json` after upgrade | 0 vulnerabilities | **PASS** audit snapshot; runtime unverified |
| Electron 44 startup/security | Not launched; executable absent | **NOT RUN** |
| Electron-44 ABI SQLite load | No binding produced | **BLOCKED** |

Required next action: approved Windows C++ build toolchain or an approved
Electron-44-compatible better-sqlite3 prebuild, with authorization for that
environment change or binary source. After native binding creation, rerun all
14 tests, verify Electron load, rerun Electron startup/security probes, audit,
build, and typecheck. Do not claim commercial readiness from the zero-audit
result.

## P0.6 native build toolchain and Electron 44 validation record

P0.6 started from clean `master` at
`d489bd510ed3e7345304984f1ddfef71674899a3`, two commits ahead of
`origin/master` at `84bd2071d087d5b46585e10dbcedea30f23b9cf9`. Package
baseline is Electron `44.9.0`, better-sqlite3 `12.11.1`, TypeScript `5.9.3`,
Node `v24.19.0`, npm `12.0.2`, Windows x64.

### Toolchain and prebuild assessment

| Check | Result | Status |
|---|---|---|
| `vswhere.exe` | Not found | **BLOCKED** |
| `cl.exe` | Not found | **BLOCKED** |
| `msbuild.exe` | Not found | **BLOCKED** |
| npm `msvs_version` / `python` overrides | Undefined | **UNVERIFIED**; node-gyp found Python 3.14.7 during attempted build |
| Electron ABI | `149` for Electron 44.9.0 | **RECORDED** |
| Node ABI | `137` for Node 24.19.0 | **RECORDED** |
| better-sqlite3 repository | WiseLibs/better-sqlite3 | **RECORDED** |
| Electron-44 Windows x64 prebuild | `prebuild-install` reported none; fallback entered node-gyp | **BLOCKED** |

The trusted package source is `better-sqlite3` from the configured npm
registry, repository `https://github.com/WiseLibs/better-sqlite3`. No binary
from an unofficial mirror or unknown source was used. The rebuild downloaded
official Electron headers from `https://artifacts.electronjs.org/headers`
through the package build flow, then stopped before compilation because
Visual Studio C++ was missing. No system toolchain installation was attempted.

Official remediation requires Visual Studio Build Tools or Visual Studio with
the **Desktop development with C++** workload, Windows SDK, and a supported
MSVC toolset. Installation may require administrator approval and changes to
system state. It is outside this stage's authorization. Alternative path is a
trusted `better-sqlite3@12.11.1` prebuild explicitly matching Electron runtime
44.9.0, ABI 149, Windows x64, with verifiable publisher/source, checksum, and
package provenance. No such prebuild was available to the attempted
`prebuild-install` lookup.

### P0.6 validation status

| Gate | Result | Status |
|---|---|---|
| Native build toolchain | Missing; no installation attempted | **BLOCKED** |
| Electron-44 better-sqlite3 binding | Not produced | **BLOCKED** |
| Electron-44 native load | Not possible | **NOT RUN** |
| Real SQLite suite after upgrade | 9 pure tests passed; 5 SQLite tests failed because binding was missing | **FAIL/BLOCKED** |
| Electron-44 startup/security | Executable absent after upgrade | **NOT RUN** |
| TypeScript check | Exit 0 | **PASS** |
| Production build | Exit 0 | **PASS** build only |
| Fresh dependency audit | 0 vulnerabilities | **PASS** audit snapshot only |

P0.6 stops at missing system toolchain. Required next authorization is one of:

1. Administrator-approved installation/use of official Visual Studio Build
   Tools with Desktop development with C++, Windows SDK, and MSVC; or
2. Security-approved, provenance-verified Electron-44/ABI-149 Windows x64
   better-sqlite3 prebuild.

After that authorization, rebuild only better-sqlite3 for Electron 44.9.0,
verify the binding loads inside Electron (not only Node), rerun all 14 SQLite
and deterministic tests, rerun Electron startup/security probes, and retain
process cleanup evidence. Do not switch Electron versions to avoid ABI work.

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
