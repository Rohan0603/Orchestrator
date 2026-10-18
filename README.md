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

Worker dispatch, Git mutation, live harness/provider integration,
independent review execution, repair loops, cancellation exercises, restart
reconciliation, packaging, and qualification remain unimplemented.

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

Crash consistency, migration qualification, backup guarantees, and recovery
reliability are not verified by this stage.

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

`src/harness/conformance.ts` records the future qualification checks and
required evidence. All checks are currently `blocked`; no adapter has passed
conformance. OpenCode remains the initial candidate. ACP, OpenCode server/API,
and CLI alternatives remain comparison candidates only. No provider or
harness integration has been selected or qualified.

Eventually, adapter facts must persist with run/attempt identity, route
identity, progress and terminal events, cancellation/reconciliation state,
and artifact/evidence provenance. This stage adds no execution records or
migration because no adapter is connected.

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
Migration/runtime behavior remains unvalidated.

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
npm start
```

Build, startup, security checks, migration exercises, and runtime qualification
were not run under Stage 1, Stage 2, or Stage 3 authorization. Node/Electron/native
SQLite compatibility remains unverified until separately authorized validation.
Independent review remains blocked by the permanent single-agent rule.
