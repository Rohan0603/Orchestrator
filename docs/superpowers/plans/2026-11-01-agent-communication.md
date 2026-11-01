# Internal Agent Communication Implementation Plan

> **For agentic workers:** Use native execution in this session; keep each phase independently testable. This document plans implementation; its checkboxes do not claim implemented or verified behavior.

**Goal:** Extend Orchestrator's SQLite-owned lifecycle with a typed, validated, at-least-once internal agent message protocol, durable consumer deduplication, bounded retries, and inspectable dead letters.

**Architecture:** Preserve the existing transactional outbox and hash-chained audit path. Keep audit facts distinct from semantic messages, even when both originate in one transaction. Add only missing consumer, delivery-attempt, claim, and dead-letter state through forward migrations; transport adapters remain behind the project-owned protocol.

**Tech Stack:** TypeScript, better-sqlite3, Electron test runner, existing migrations and repositories.

**Spec:** User-provided implementation plan and required refinements, reviewed 2026-11-01. Requirements are captured below; read README.md, MVP_plan.md, docs/ARCHITECTURE.md, and COMMERCIAL_READINESS.md before execution.

## Global constraints

- SQLite remains authoritative. Producer state mutation, audit fact, and semantic outbox intent commit together.
- Consumer domain mutation, audit fact, and processed-message acknowledgement commit in the same SQLite transaction whenever they share the database boundary. Both effect and acknowledgement commit, or neither does.
- At-least-once delivery requires idempotent processing; calling a handler is not acknowledgement. External effects require reconciliation when their outcome is uncertain.
- Workers report claims; the orchestrator retains lifecycle, policy, approval, recovery, review, and acceptance authority.
- Preserve Electron isolation, IPC validation, lease ownership, ordered worker messages, and single-active-worker defaults.
- No second queue, second LLM client, broker, A2A integration, delegated execution, automatic acceptance, or automatic replay of uncertain external work.
- Preserve unrelated checkout changes and raw experiment records. Do not edit MVP_plan.md to record progress or promote release gates without required evidence.

## Review focus

- Restart/redelivery after committed consumer processing cannot repeat the transition, even if dispatcher completion was not persisted.
- Unsupported version, unknown type, invalid envelope, invalid typed payload, and oversized input have separate validation dispositions and never reach handlers.
- Non-transient failures never enter transient retry loops; unknown external outcomes require reconciliation.
- Stale lifecycle state and stale attempts cannot overwrite newer authoritative state.
- Required-action dead letters update the owning workflow truthfully instead of leaving ordinary pending work indefinitely.

## Repository map and decisions

- Extend `src/shared/agent-message.ts`: the existing generic payload validator is insufficient. Preserve compatible callers deliberately; migrate call sites if changing its contract.
- `src/persistence/events.ts` provides `appendDurableEvent` and `EventRepository`. The repository wrapper opens a transaction; the helper itself depends on its caller's transaction. Preserve hash chaining and existing audit/outbox behavior, and prove producer atomicity at the owning transaction boundary.
- Audit events record facts; semantic messages request processing. Use an explicit semantic discriminator in the existing outbox path. Legacy audit outbox rows must not accidentally become handler commands. Never create competing `agent_messages` or `message_outbox` queues.
- Extend `src/persistence/migrations.ts` after the current final migration (the supplied plan identifies version 11; recheck at execution time). Do not rewrite applied migrations.
- `src/sdk/repositories.ts` owns lease-checked, per-run sequenced worker messages. Preserve those checks rather than replacing worker persistence with a generic queue.
- `src/shared/domain.ts` owns lifecycle and audit correlation types. New protocol types remain transport-independent.
- Add `src/persistence/message-delivery-repository.ts` for consumer durability and transactional claims, and `src/dispatch/internal-message-dispatcher.ts` for bounded local scheduling.
- Add `tests/agent-message.test.ts` and `tests/message-delivery.test.ts`; extend `tests/sdk.test.ts` for the lifecycle slice. Register exact suite counts in `package.json`.
- Existing size precedent: `src/shared/agent-message.ts` and `src/sdk/capability-runtime.ts` use 1 MiB. Name the internal envelope limit `MAX_AGENT_MESSAGE_BYTES = 1024 * 1024`, measured over UTF-8 serialized envelope bytes; document this as reuse of a local precedent, not provider qualification. Larger content belongs in artifact references.

## Task 1: Protocol contracts

**Files:** Modify `src/shared/agent-message.ts`; create `tests/agent-message.test.ts`; update affected callers only.

**Interface:** `parseAgentMessage(value: unknown)` returns a discriminated success result containing `AgentMessage`, or a classified validation error. `AgentMessage` is a union discriminated by `messageType`; every supported member has a concrete payload schema. Retain a boolean validator only as a wrapper over this parser if callers need it.

- [x] Write failing tests for valid typed payloads, invalid envelope, unsupported version, unknown type, known type with invalid payload, unserializable input, and UTF-8 byte boundaries including multibyte strings.
- [x] Define the minimal supported registry and message-specific payload types. Unsupported existing registry entries must fail closed until they have schemas; do not advertise broad protocol coverage from string names alone.
- [x] Include schema version, stable message ID, sender/recipient, timestamp, correlation/causation, and authorization context. Lifecycle messages require taskId, runId, attemptId, and expected lifecycle state/version according to the existing domain representation. Only explicitly non-run message types may omit those identities.
- [x] Implement envelope plus payload validation with separate error codes: `invalid_envelope`, `unsupported_version`, `unknown_type`, `invalid_payload`, `oversized_message`. Serialization failures are invalid input, never uncaught handler input.
- [x] Ensure handlers consume narrowed payload types, never raw JSON or an unchecked record. Schema validity does not grant authorization.
- [x] Run the focused protocol suite under the existing runner; confirm failures first and then passing assertions.

## Task 2: Consumer durability and atomic acknowledgement

**Files:** Modify `src/persistence/migrations.ts` and `src/persistence/events.ts`; create `src/persistence/message-delivery-repository.ts` and `tests/message-delivery.test.ts`.

**Interface:** The delivery repository exposes enqueue metadata on the existing outbox, atomic claim, transactional consume-once, attempt completion/failure, and dead-letter inspection. Consumer handlers are synchronous database operations on the same connection; reject asynchronous handlers in this transaction API.

- [x] Write failing tests for forward migration of an existing database, rollback, restart persistence, and consumer-specific deduplication.
- [x] Keep separate durable concepts: outbox intent; delivery attempts; processed messages keyed by `(consumer_id, message_id)`. Retain terminal failure details for dead-letter inspection. A generic `sent` status is not sufficient.
- [x] Persist consumer destination, ordering scope/sequence, due time, attempt number, error classification, and claim owner/token/timestamps/expiry. Link these records to the existing outbox; do not duplicate its authoritative message body.
- [x] Implement consume-once as one transaction: check consumer/message identity, validate authority, apply domain effect, append its audit fact, insert the processed acknowledgement. Throwing at any point rolls back all changes. Reuse of an identity with different content is a conflict, not a successful duplicate.
- [x] Define processed acknowledgement as durable consumer commit. Dispatcher bookkeeping may follow later; outbox publication must not mean merely invoking a handler. Preserve existing audit publication semantics and keep semantic delivery completion explicit.
- [x] Verify rollback leaves the message processable; a duplicate for the same consumer performs no effect, while a different consumer can process independently. Close/reopen the disposable database to prove persistence.

## Task 3: Bounded local dispatcher

**Files:** Create `src/dispatch/internal-message-dispatcher.ts`; extend delivery repository and delivery tests.

**Interface:** `dispatchDue(now, limit)` processes a bounded batch using an injected clock and consumer registry. It returns dispositions; consumer commit determines acknowledgement. Configure retry bounds explicitly and persist scheduling.

- [x] Write failing tests for competing claims, expired ownership, ordering, bounded batches, retry exhaustion, and every classification below.
- [x] Claim eligible deliveries atomically with a unique fencing token. Completion/failure updates require the current token; an expired owner cannot acknowledge a newer claim.
- [x] Order within `(consumer_id, runId)` using a persisted monotonic sequence allocated in the producer transaction. An unresolved earlier message blocks later messages in that scope. Unrelated runs may advance; promise no global ordering. Do not repurpose worker-direction sequences.
- [x] Use provisional local defaults of five total attempts and deterministic capped exponential delays of 1, 2, 4, and 8 seconds. Inject policy/clock for tests; persist next due time and attempt history so restart does not reset budgets.
- [x] Classify outcomes explicitly using the table below. Record failed attempts durably; failure to persist bookkeeping must leave delivery unresolved, never falsely acknowledged.
- [x] On expired ownership, consult the processed ledger first. Safely redeliver only database-only atomic consumers with no committed acknowledgement. Possible external effects enter recovery; expiry never proves a worker stopped.
- [x] Expose dead-letter inspection with message/consumer IDs, attempts, sanitized reason, correlation, and owning workflow. Do not implement automatic dead-letter replay.
- [x] Pass focused tests proving claim fencing and that only transient failures consume the retry schedule.

| Classification | Examples | Disposition |
| --- | --- | --- |
| transient | Consumer temporarily unavailable; startup failure known to precede effects; recoverable SQLite busy | Persist bounded backoff; exhaustion becomes dead letter |
| permanent | Unsupported version/type, invalid payload, impossible destination | Dead letter without transient retries |
| policy | Denied authorization, unavailable capability, missing/expired approval | Stop delivery; record policy reason and apply existing blocked semantics |
| conflict | Stale lifecycle state or superseded attempt | Record terminal conflict; never mutate newer state or retry blindly |
| uncertain | External effect may have occurred; unknown failure after dispatch | Mark reconciliation/recovery required; no automatic replay |

Unknown exceptions default to uncertainty unless the transaction boundary proves rollback and the failure is explicitly classified safe to retry.

## Task 4: One lifecycle vertical slice

**Files:** Modify `src/sdk/repositories.ts`, protocol contracts, and delivery integration; extend `tests/sdk.test.ts` and delivery tests.

**Scope:** Use the existing successful worker report -> `verification` transition. Emit one `review.requested` semantic message to a local review-intake consumer. Review intake durably records a request and its evidence references; it does not execute an independent reviewer or accept a task. Keep the run in verification until existing review gates permit further transition.

- [x] Write failing integration tests for producer rollback, consumer rollback, identity mismatch, stale attempt/state, denied authorization, and full correlation/causation.
- [x] Make worker report persistence, existing run/attempt updates, audit facts, and semantic enqueue atomic. The current `reportTask` persists a worker message before its transition transaction; include that write in the owning transaction for this slice so a failed transition does not leave a report treated as completed.
- [x] Preserve lease and per-run worker sequence checks and versioned handoff semantics. No additional message types or alternate worker handoff architecture are required.
- [x] Before consuming, check schema, authorization, task/run relationship, authoritative attempt, expected state/version, and legal transition/request. Compare-and-set updates must check affected row counts. Resolve authority from persisted state rather than worker claims or timestamps.
- [x] Commit review-intake effect, audit fact, and inbox acknowledgement atomically. Persist task/run/attempt, correlation ID, and causation linking the worker report, producer event, semantic message, and consumer event.
- [x] If this required action dead-letters or becomes uncertain, update its still-authoritative owner to the existing blocked/inconclusive/recovery-required representation in the same terminal transaction. A stale failure cannot damage a newer attempt. Never leave an otherwise ordinary pending workflow indefinitely.
- [x] Verify one end-to-end report/enqueue/dispatch/intake/ack path; worker success remains short of acceptance.

## Task 5: Recovery and failure proof

**Files:** Extend `tests/message-delivery.test.ts` and `tests/sdk.test.ts`.

- [x] Reopen after producer commit but before dispatch: exactly one consumer effect and acknowledgement result.
- [x] Reopen after effect+inbox commit but before dispatcher completion: redelivery consults inbox, repeats no transition, and repairs bookkeeping.
- [x] Inject failure after the domain SQL effect but before inbox insertion inside the transaction: effect and acknowledgement both roll back; redelivery processes once. There is no independently committed SQLite effect-before-inbox window under this design.
- [x] Inject failure after inbox insertion but before domain transaction completion: acknowledgement rolls back with the failed effect; the message remains processable.
- [x] Test persisted retries/exhaustion, two competing claimers, expired-token fencing, required-action dead-letter propagation, malformed payload, unknown type/version, size rejection, stale lifecycle state, and attempt-1 reporting after attempt-2 becomes authoritative.
- [x] Test an uncertain external outcome with a fake side-effect adapter: record recovery required and assert zero automatic replays. This is simulation evidence, not real Git/process-crash qualification.
- [x] Use disposable databases and deterministic injected clocks. Label exception injection and close/reopen tests accurately; real abrupt-process termination remains unverified unless separately exercised.

## Task 6: Evidence, documentation, and completion checks

**Files:** Update `docs/ARCHITECTURE.md`, `docs/VALIDATION_EVIDENCE.md`, `COMMERCIAL_READINESS.md` only where new evidence applies, and `package.json` test registration.

- [x] Document implemented behavior separately from proof using explicit labels: IMPLEMENTED, VERIFIED BY UNIT TEST, VERIFIED BY INTEGRATION TEST, FAULT-TESTED (with exact method), NOT FAULT-TESTED / UNVERIFIED, NOT IMPLEMENTED, and FUTURE.
- [x] Record audit/message distinction, transaction boundaries, per-consumer/per-run ordering, claim expiry, retry defaults, payload-limit source, authority checks, required-action failure propagation, and remaining adapter limitations.
- [x] State that A2A, NATS/RabbitMQ/Kafka, real external-effect crash safety, live adapter delivery qualification, and independent review execution are not implemented or not verified as applicable. Passing SQLite tests does not clear commercial runtime gates.
- [x] For each focused suite run `npm run build:native-helper`, then `npx tsc -p tsconfig.test.json`, then `node scripts/run-electron-tests.mjs --expected=<actual-count> dist-test/tests/<suite>.test.js`. Set actual counts from test declarations; do not copy stale counts from prose.
- [x] Run `npm run build` and canonical `npm test`. Record actual results and blockers; ordinary Node.js must not execute compiled SQLite suites.
- [x] Run `git diff --check`, inspect `git status --short`, and review the exact scoped diff including newly created files. Preserve unrelated changes and do not stage credentials, runtime databases, generated output, or raw evidence modifications.

**Stop condition:** The one lifecycle slice and its consumer durability guarantees are implemented and pass the specified Electron-backed checks, documentation matches actual evidence, and all remaining runtime/adaptor qualification gaps remain explicit. Do not expand into additional lifecycle message migrations.


## Execution record — 2026-11-01

Implemented in the current checkout on `codex/internal-agent-communication`,
preserving existing uncommitted SDK/provider work. `npm run build` and canonical
`npm test` pass (89 Electron cases and 4 runner tests); `git diff --check` passes.
See `docs/VALIDATION_EVIDENCE.md` for guarantee-specific evidence and limitations.

Execution rulings: the delivery pump is explicit after SDK reports and through
`dispatchInternalMessages`, with no background timer. Current-owner terminal
conflicts block required review intake through guarded updates; stale owners
remain protected. Reconciliation consumes batch capacity and continues to other
due work. Audit predecessor selection follows insertion order rather than clock
or UUID order. The test runner rejects failure markers masked by Electron's
exit code, and lease-expiry tests use explicit persisted expiry.

The phase checkboxes record implementation and the specified tests, not release
qualification. Independent reviewer execution, real abrupt-process crashes,
external-effect reconciliation qualification, and extra lifecycle consumers
remain outside this completed slice.
