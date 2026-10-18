# Orchestrator

Windows-first, local, single-user agentic development orchestrator.

## Foundation status

Stage 1 foundation establishes:

- Electron main, preload, and renderer boundaries.
- Renderer sandboxing, context isolation, disabled renderer Node integration,
  restrictive Content Security Policy, and narrow typed IPC.
- SQLite-owned task and lifecycle schema with versioned migrations.
- Typed task domain models and fail-closed lifecycle transition helpers.
- Main-process task creation/listing and application status operations.

Fixture worker dispatch and one live OpenCode CLI JSON route are implemented.
The live route is provisionally qualified only through the durable experiment
runners; UI dispatch still uses the deterministic fixture adapter. Git mutation
through the production UI, independent review execution, repair loops, and
cancellation exercises remain unqualified. Minimal restart reconciliation and
local Windows packaging are implemented but not release-qualified.

Stage 2 adds source-level policy decisions, risk classification, one-shot
exact-context approval contracts, and workspace/Git safety contracts. These
contracts do not execute actions or invoke Git.

## Data ownership

The Electron main process owns SQLite, filesystem, Git, process, and future
provider operations. The renderer receives typed projections through preload.
SQLite is authoritative for structured lifecycle state. Filesystem and Git
hold source and artifacts; they are not security boundaries.

## Database and migrations

The main process opens one SQLite database under Electron's user-data directory.
Versioned SQL migrations create the foundational task, run, attempt, approval,
policy-decision, workspace-target, audit, outbox, evidence, and recovery
tables. Migration or transaction failure is surfaced as an error; no success
fallback is used.

Crash consistency, backup retention guarantees, and full recovery reliability
are not verified by this stage. SQLite backup/restore integrity is covered by
the Electron test suite.

Policy decisions and approval records remain distinct from execution outcomes.
Missing capabilities, evidence, prerequisites, invalid context, expired
approvals, consumed approvals, and prohibited operations fail closed.

## Harness adapter contract

Stage 3 defines the project-owned, versioned contract in
`src/harness/adapter-contract.ts` (`harness-adapter-v1`). It describes adapter
identity, provider/model route identity, capability discovery, authorized
dispatch correlation, ordered progress events, terminal worker outcomes,
cancellation ownership, deadlines, evidence provenance, reconciliation, and
idempotent duplicate-dispatch handling. The contract does not execute a
harness or provider.

Capability entries use only `supported`, `unsupported`, `conditional`, or
`unverified`. Missing entries resolve to `unverified`. Mandatory capabilities
that are missing, unsupported, unverified, or conditional without explicitly
satisfied prerequisites block routing. Optional gaps are reported but do not
silently substitute a route. Provider or model identity must be known before a
route is ready; fallback requires explicit task and policy permission plus an
independently qualified destination.

Worker terminal outcomes remain separate from orchestrator acceptance. Lost
connections, ambiguous provider errors, incomplete evidence, unverified
cancellation, and unknown reconciliation state remain non-success outcomes.
The orchestrator owns policy, approval, route selection, deadlines,
cancellation, recovery, verification, review, and acceptance.

`src/harness/conformance.ts` records the qualification checks and required
evidence. Deterministic fixture checks cover contract behavior. OpenCode
`1.19.0` CLI JSON is provisionally qualified through
`src/harness/opencode-cli-adapter.ts` and three durable trials using
`opencode/mimo-v2.6-flash-free`. ACP and OpenCode server/API remain
unqualified. Provider credentials are never written to repository evidence.

Qualified CLI adapter facts are retained in trial records with run/attempt
identity, route identity, progress and terminal events, usage telemetry when
reported, and artifact/evidence provenance. The route is exercised through
explicit experiment runners, not silently wired into renderer task execution.

`src/execution/local-execution.ts` now connects policy, route eligibility,
durable run/attempt state, dispatch intent, fixture-adapter progress, terminal
classification, and fail-closed outcomes for local deterministic tests. A
fixture success reaches `verification`; it is not marked accepted without
orchestrator-verified acceptance evidence.

## Stage 4 dispatch and evidence boundary

`src/dispatch/dispatch-contract.ts` defines single-worker dispatch eligibility.
It requires valid task criteria, dispatchable lifecycle state, pending attempt,
allowed or exact-approved policy, confirmed workspace, qualified route,
explicit route identity, satisfied prerequisites, future deadline, and a
repair-cycle count within the initial-attempt-plus-two-repairs bound. Existing
dispatch intent blocks duplicate dispatch. Persisted intent must precede any
future adapter call.

`src/evidence/evidence.ts` separates worker/adapter claims from
orchestrator-verified evidence. Evidence status, provenance, content identity,
capture time, completeness, and independent verification are explicit.
Missing, incomplete, invalid, or unverified evidence is not acceptable proof.
`src/persistence/dispatch-repository.ts` provides main-process persistence
boundaries for intents, progress cursors/events, and evidence records.
Electron SQLite tests validate migrations, transactions, restart reconciliation,
and persistence errors on disposable databases.

Progress events require matching correlation and strictly increasing sequence;
duplicates and out-of-order events are non-success dispositions. Failed,
cancelled, timed-out, disconnected, or inconclusive worker outcomes do not
become acceptance. Disconnected or ambiguous outcomes remain recovery-required
and cannot trigger automatic redispatch.

## Setup

Install dependencies with authorized npm access, then use the existing scripts:

```text
npm install
npm run build
npm test
npm start
```

After startup, create a task with one or more acceptance criteria. Risk-tier 1
tasks expose **Run local fixture**. This executes only the deterministic local
fixture adapter through policy, route, durable dispatch, progress, and terminal
classification. It does not invoke OpenCode, a provider, a shell, or a real
worker. Successful fixture work stops at `verification` until independent
orchestrator acceptance evidence exists. Each task now displays persisted run
and attempt history, including recovery-required and disconnected outcomes.
Startup reconciles interrupted running attempts before opening the renderer;
uncertain work remains blocked and is never replayed automatically.
Successful fixture attempts also persist an orchestrator acceptance decision.
Current decision is `blocked` because no independent reviewer or complete
verified evidence exists; worker success never becomes task acceptance.

Deterministic failure injection covers uncertainty after dispatch intent,
after fixture launch acknowledgement, and before terminal persistence. Each
case records `recovery_required` and does not replay its dispatch intent.

`npm test` compiles all suites, then runs eleven deterministic contract tests,
three adapter conformance tests, five local execution/restart tests, eight real
SQLite tests, and one real Electron second-WebContents IPC test: 28 tests total. The
Electron-targeted native SQLite
binding cannot load under ordinary Node.js; use `npm test` rather than invoking
the compiled tests with `node --test`.

The IPC integration test proves an authorized primary renderer can create a
task while a second real `WebContents` and a `data:`-origin window receive
`UNTRUSTED_SENDER` before mutation. Malformed payloads and unknown task IDs
are rejected without mutation. Subframe adversarial calls remain unverified
because sandboxed subframes do not receive the production preload API.

Runtime requirements: Windows x64, Node.js `24.x`, npm `12.x`, Electron
`44.9.0`, and `better-sqlite3` compiled for Electron ABI `149`. Native
compilation requires the official Visual Studio Build Tools C++ workload and a
compatible Windows SDK.

`npm run package:win` builds the application and creates an unsigned Windows
x64 Electron package under `out/` using project-local Electron Packager.
The package includes the Electron-ABI-149 native SQLite binding. This is an
unmanaged application directory, not an installer or signed release.
Clean-machine installation, process cancellation qualification, independent
review, and production UI wiring for the live adapter remain unverified or
blocked. The live CLI route is exercised only with the explicit runner:

```text
npm run build
node experiments/runners/run-opencode-cli.mjs --fixture <git-dir> --model opencode/mimo-v2.6-flash-free --output <new-json> --source-revision <commit>
```

For SQLite-authoritative durable qualification, use the Electron test harness
and environment variables documented in
[experiments/runners/README.md](experiments/runners/README.md).

## Research artifacts

- [Research charter](docs/RESEARCH_CHARTER.md)
- [Implemented architecture](docs/ARCHITECTURE.md)
- [Decision register](docs/DECISION_REGISTER.md)
- [Experiment protocol](docs/EXPERIMENT_PROTOCOL.md)
- [Research status](docs/RESEARCH_STATUS.md)
- [Commercial product handoff](docs/COMMERCIAL_PRODUCT_HANDOFF.md)
- [Experiment decision report](experiments/DECISION_REPORT.md)

The experiment tree stores pinned configuration, fixture/verifier conventions,
trial schema, raw-result/report conventions, and three retained live
OpenCode CLI JSON trial records. It does not claim general provider
reliability; unavailable prerequisites remain blocked.

## Commercial readiness

[COMMERCIAL_READINESS.md](COMMERCIAL_READINESS.md) is the current
commercial-readiness validation matrix. It records evidence-backed status,
blocked gates, remediation order, and release stop conditions. No gate is
marked passed without corresponding evidence; the product is not currently
recommended for publication.
