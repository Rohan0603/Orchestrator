# Implemented architecture

## SDK-first backend

The backend is usable without the Electron renderer through `src/sdk`.
`OrchestratorSdk` is the application boundary for projects, workers, task
claims, leases, skills, MCP server profiles, plugins, worker messages, worker
reports, run streaming, and direct freellmapi task planning. Future CLI, HTTP,
or UI surfaces should call this boundary rather than write SQLite directly.

The durable building blocks are:

- **Project** — repository-level grouping and default branch metadata.
- **Task** — a unit of work with criteria, risk, parent/project links, selected
  skill/MCP/plugin IDs, and a token budget.
- **Run / Attempt** — one execution and its retry/recovery identity.
- **Worker lease** — an expiring, single-owner claim over a task run.
- **Handoff** — versioned `orchestrator-worker-v1` context containing
  correlation IDs, criteria, selected skill instructions, MCP descriptors, and
  budget, recorded before worker execution.
- **Worker message** — ordered, idempotent progress/heartbeat/report/error
  traffic persisted before it is considered delivered. Worker reports require
  adapter and session references alongside run/attempt correlation; those
  references are source claims and do not qualify adapter identity by themselves.
- **Evidence / Audit event** — worker claims remain distinct from
  orchestrator-verified acceptance evidence; audit events are hash chained and
  atomically placed in the outbox.

Worker communication is at-least-once and therefore requires a lease token,
strict per-run sequence numbers, correlation IDs, and idempotency keys. Lease
expiry is fail-closed before another worker can claim the task. A worker report
moves a run to verification, rejection, or inconclusive; it never directly
accepts a task.

## Boundaries

Electron main owns SQLite, filesystem, Git, process, and future provider
operations. Sandboxed renderer code receives only typed preload methods.
Context isolation, disabled Node integration, restrictive CSP, sender/frame
validation, and payload validation remain required boundaries.

The Rust migration remains incremental. Electron initializes the existing
schema-13 database, then starts one Rust core process on the same path. The
Electron UI, GitHub-import, and headless CLI task-create paths now route task creation to Rust,
which owns the atomic task/revision/idempotency/audit/outbox write set. The
TypeScript task repository does not serve those production entrypoints. Other
lifecycle writes remain on the TypeScript conformance baseline until their
ordered migrations. The Rust connection validates the schema and provides
explicit WAL/checkpoint, backup, transaction, and task-read parity primitives.
No application path may let both backends write the same authoritative
responsibility. See
[`persistence/rust-sqlite-cutover.md`](persistence/rust-sqlite-cutover.md).

## Durable state

SQLite stores tasks, runs, attempts, approvals, policy decisions, dispatch
intents, progress cursors/events, evidence, acceptance decisions, audit events,
outbox records, recovery state, projects, workers, leases, skills, MCP profiles,
plugins, worker messages, and LLM usage. Schema changes use versioned
migrations.
Task content has immutable, content-hashed revision snapshots; explicit
dependency edges and idempotent create-command keys also live in SQLite.
Filesystem and Git hold source, diffs, and artifacts; they are not security
boundaries.

## Execution flow

Task intake -> policy evaluation -> route/capability evaluation -> exact
approval when required -> durable dispatch intent -> adapter execution ->
ordered progress and terminal outcome -> orchestrator verification/review ->
bounded repair or acceptance/rejection. Unknown or ambiguous outcomes enter
`recovery_required`; they are not replayed automatically.

For SDK execution, task claim and worker execution are separate from the sole
LLM path. The orchestrator calls the direct OpenAI-compatible freellmapi
adapter, streams SSE content into durable progress/audit records, records
token usage, and emits a concise planning/handoff stream. Workers do not
connect to an LLM; they receive the handoff and report structured outcomes
back through the SDK.

SDK claims use an immediate SQLite write transaction and enforce configured
global and per-worker active-lease limits (both default to one). Expired leases
are reconciled as unknown execution outcomes before task selection; retries
require a persisted reconciled recovery result and an explicit SDK retry call.

Skills, MCP server definitions, and plugins are installed into the
orchestrator registry and selected by ID on a task. Only selected skill
instructions are included in the LLM prompt to control token use. MCP profiles
are handed to workers as descriptors; installing a profile does not grant
execution or bypass policy. Capability calls and plugin results are reported as
ordered worker messages. Plugins are trusted local code and currently execute
inside the orchestrator runtime; production deployments must restrict plugin
entrypoints and filesystem permissions.

## Current implementation boundary

The deterministic fixture adapter exercises lifecycle and persistence behavior.
The freellmapi OpenAI-compatible HTTP/SSE adapter is the sole LLM provider
route and is available to the SDK for direct streamed planning. Endpoint
qualification, provider-side cancellation, restart reconciliation, independent
review execution, and commercial packaging remain separate qualification work.
Missing mandatory capability or identity blocks worker dispatch. SDK streaming
never marks a task accepted from an LLM response alone.

## Framework decision

LangChain/LangGraph are intentionally not runtime dependencies. The core
workflow already owns SQLite durability, leases, idempotency, audit/outbox
delivery, recovery, policy, and acceptance. Direct freellmapi HTTP/SSE keeps
the only LLM connection explicit and minimizes framework/prompt overhead. MCP
is a worker capability protocol and registry concern, not an alternate model
provider.

## Internal semantic delivery

Schema 12 extends the existing outbox rather than introducing another queue.
Audit facts still use `appendDurableEvent`; semantic envelopes use
`outbox.event_type = internal.message`. The generic audit publisher excludes
those rows and cannot mark them published. Audit chaining follows durable
append order, including equal or backwards timestamps; existing audit records
are preserved.

`src/shared/agent-message.ts` supports concrete discriminated schemas for
`review.requested` and `task.progress`. Only the former is integrated with a
lifecycle consumer. Parsing returns a validated JSON snapshot or a distinct
invalid-envelope, unsupported-version, unknown-type, invalid-payload, or
oversized-message error. Handlers receive the parsed union. The entire UTF-8
serialized envelope is limited to 1 MiB, reusing the existing local message and
capability-runtime precedent. Scheduling timestamps must be canonical UTC ISO
strings. Large content belongs in artifacts referenced by ID.

Outbox intent, `message_delivery_attempts`, and `processed_messages` are
separate records. Consumer deduplication is keyed by consumer ID and message
ID, with a content hash to reject identity reuse. Trusted producers can
register separate consumer subscriptions to the same immutable message;
recipient authorization is still checked by the consumer. Delivery metadata
retains run/task/attempt identity and correlation/causation independently of
parsing a potentially invalid message.

`MessageDeliveryRepository` uses immediate SQLite transactions for claims and
synchronous database-only consumption. Persisted owner/token/expiry fields
fence replaced owners. Domain effect, consumer audit fact, and inbox insertion
commit together. Inbox commit is the authoritative acknowledgement; dispatcher
bookkeeping follows and can be recovered without repeating the effect.
Reconciliation counts against the bounded dispatch batch and does not stall
unrelated due work. Claim expiry indicates expired delivery ownership; it does
not prove an external worker stopped.

Ordering is per `(consumer_id, run_id)`, with a sequence assigned in the
producer transaction. Unresolved earlier deliveries block later ones in that
scope; unrelated runs may proceed. No total global ordering is promised.
Transient failures default to five total attempts with persisted 1, 2, 4, and
8 second delays. Only explicitly transient failures and recoverable SQLite
busy/locked failures after transaction rollback retry. Permanent, policy,
conflict, and uncertain outcomes are terminal delivery dispositions. Unknown
exceptions become uncertain, never automatic external-effect replay.
`deadLetters()` exposes terminal disposition, classified code, attempt history
links, owning IDs, correlation, and the stored envelope. Failure reasons are
restricted to sanitized codes rather than arbitrary exception contents.

The integrated slice is successful SDK worker report -> verification ->
`review.requested` -> durable `review_requests` intake. Worker report,
lifecycle mutation, audit facts, and semantic enqueue share a transaction.
The consumer checks authorization, task/run/attempt relationships, newest
persisted run/attempt, expected lifecycle revision/state, successful report,
and evidence relationships before committing intake and acknowledgement.
A SQLite trigger increments lifecycle revision on state changes, including
existing lifecycle writers. Current-owner required-action failures mark the
workflow blocked; uncertain outcomes mark it inconclusive with recovery
required. Guarded updates cannot damage a superseding run/attempt/revision.

`reportTask()` drives a bounded delivery batch after its producer transaction
commits. Backend callers resume persisted due work after reopening, and drive
retries when due, using `sdk.dispatchInternalMessages(now?, limit?)`. There is
no background timer, automatic external worker redispatch, or remote adapter
attached to this pump. Consumers must perform only synchronous SQLite work on
the owning connection; arbitrary trusted local code is not an isolation
boundary, and rejecting async callbacks does not sandbox external effects.

Review intake records requests and evidence references; it does not execute an
independent reviewer or grant acceptance. Real process termination during
external Git/provider effects, external transport delivery, and live adapter
reconciliation remain unverified. Brokers and A2A remain unimplemented.
