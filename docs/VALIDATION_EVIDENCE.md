# Validation evidence

Audit date: 2026-10-26.

## Current implementation

The sole provider path is the freellmapi OpenAI-compatible HTTP/SSE adapter:

- `src/harness/openai-compatible-adapter.ts`
- `experiments/runners/run-freellmapi-smoke.mjs`
- Configuration uses `ORCHESTRATOR_OPENAI_BASE_URL`,
  `FREELLMAPI_API_KEY`, and `ORCHESTRATOR_OPENAI_MODEL`.
- Credentials are never written to logs, trial records, or repository evidence.

The adapter supports request creation, structured streamed progress, terminal
outcomes, usage capture, local request abort, route identity, and fail-closed
capability reporting. Provider-side cancellation ownership, restart
reconciliation, and artifact provenance remain unverified.

## Checks

| Check | Result |
|---|---|
| `npm run build` | PASS |
| `npm exec tsc -- --noEmit` | PASS |
| `npm test` | PASS |
| OpenAI-compatible adapter conformance | PASS |
| `npm audit --json` | 0 vulnerabilities |
| `git diff --check` | PASS |

## Live endpoint status

No live freellmapi endpoint was configured during this pass. Run the setup and
smoke trial only after configuring the local endpoint and environment variables:

```text
npx freellmapi setup-generic --url http://127.0.0.1:31415
set ORCHESTRATOR_OPENAI_BASE_URL=http://127.0.0.1:31415/v1
set FREELLMAPI_API_KEY=<secret>
set ORCHESTRATOR_OPENAI_MODEL=auto
npm run build
node experiments/runners/run-freellmapi-smoke.mjs --output <new-json> --source-revision <commit>
```

Until that trial completes, no provider acceptance or production dispatch
qualification is claimed.

## Local ownership evidence

The native Job Object helper and fixture tests qualify local process ownership
and cleanup behavior independently of the HTTP provider adapter. That evidence
does not prove that a remote freellmapi request stopped processing after a
local abort.

## Release gates

Commercial release remains blocked pending live endpoint qualification,
provider-side cancellation/restart evidence, independent review, clean-machine
installation, signing, and release authorization.

## Internal communication implementation — 2026-11-01

The internal communication plan is implemented as one SDK review-intake slice
with schema-12 delivery persistence. Evidence below applies to disposable
SQLite databases under Electron, not commercial runtime qualification.

| Guarantee | Implementation and evidence classification |
| --- | --- |
| Discriminated message payloads, distinct validation errors, canonical timestamps, UTF-8 envelope limit | IMPLEMENTED; VERIFIED BY UNIT TEST in `tests/agent-message.test.ts` |
| Forward migration preserves schema-11 state and generic audit outbox rows | IMPLEMENTED; VERIFIED BY INTEGRATION TEST in `tests/message-delivery.test.ts` |
| Domain effect, consumer audit, and inbox commit atomically | IMPLEMENTED; VERIFIED BY INTEGRATION TEST; FAULT-TESTED with synchronous exception and SQLite-trigger rollback injection |
| Reopen before delivery and after consumer commit but before dispatcher completion | IMPLEMENTED; VERIFIED BY INTEGRATION TEST with database close/reopen; abrupt OS crash NOT FAULT-TESTED |
| Consumer deduplication, identity conflicts, separate delivery attempts, fenced claims, ordering, persisted retry bounds, required-action failure propagation | IMPLEMENTED; VERIFIED BY INTEGRATION TEST including two open database connections and deterministic clocks |
| Unknown outcomes require recovery and receive no automatic retries | IMPLEMENTED; VERIFIED BY INTEGRATION TEST with fake consumer failures; real external side effects UNVERIFIED |
| Atomic worker report, lifecycle state, audit, semantic enqueue, and correlated review intake | IMPLEMENTED; VERIFIED BY INTEGRATION TEST in `tests/sdk.test.ts`, including producer rollback and stale-attempt rejection |
| SDK claim and capability policy decisions, exact one-shot approvals, unsupported-route denial, prohibited operation denial before execution, and idempotent replay | IMPLEMENTED; VERIFIED BY ELECTRON INTEGRATION TEST in `tests/sdk.test.ts` |
| Expired worker lease persists unknown outcome across file-backed SQLite reopen, blocks automatic replay, and permits an explicit retry only after recovery is reconciled | IMPLEMENTED; VERIFIED BY ELECTRON INTEGRATION TEST in `tests/sdk.test.ts` |
| Global and per-worker SDK lease limits are enforced under an immediate transaction and shared by independent SQLite connections | IMPLEMENTED; VERIFIED BY ELECTRON INTEGRATION TEST in `tests/sdk.test.ts` |
| SDK claims exclude runs still awaiting approval, running, under verification/review, or carrying an unacknowledged required delivery | IMPLEMENTED; VERIFIED BY ELECTRON INTEGRATION TEST in `tests/sdk.test.ts` |
| Forward migration adds immutable task revision snapshots, dependency edges, and task-command idempotency; legacy tasks are backfilled | IMPLEMENTED; VERIFIED BY ELECTRON SQLITE INTEGRATION TEST in `tests/sqlite-runtime.test.ts` |
| Uncertain `task.progress` delivery fences the current running run into `recovery_required`; stale lifecycle revisions and attempts cannot rewrite newer state | IMPLEMENTED; VERIFIED BY ELECTRON INTEGRATION TEST in `tests/message-delivery.test.ts` |
| Audit hash predecessor follows append order despite backwards timestamps | IMPLEMENTED; VERIFIED BY INTEGRATION TEST |
| Runner rejects printed failures even when Electron exits zero | IMPLEMENTED; VERIFIED BY UNIT TEST in `scripts/run-electron-tests.test.mjs` |
| Independent reviewer execution, additional lifecycle consumers, background delivery pump | NOT IMPLEMENTED by this slice |
| A2A and NATS/RabbitMQ/Kafka | NOT IMPLEMENTED; external boundary work is FUTURE |
| Real abrupt crash during Git/provider mutation, live transport delivery, provider cancellation | UNVERIFIED / NOT FAULT-TESTED by this work |

The SDK expiry test now explicitly persists an expired lease instead of relying
on a 1 ms wall-clock race. The test runner now checks failure markers because
the existing Electron preload's `app.quit()` can mask the test exit code.
Neither change relaxes acceptance criteria.

Final working-tree validation on 2026-11-01:

- `npm run build`: PASS.
- `npm test`: PASS, 98 Electron test cases plus 4 Node-based runner tests
  (102 passing markers, zero failure markers). Native helper build and test
  compilation completed through the canonical script.
- `git diff --check`: PASS with repository-default line-ending handling.
- Fresh scoped code review: three durability findings corrected with
  regressions; reviewer recheck found no remaining important issues.

Focused suites comprise 15 SQLite runtime tests, 3 protocol tests, 20 delivery
tests, and 17 SDK tests. Fault injection means SQLite trigger/exception simulation;
close/reopen means graceful database reopen, not an abrupt OS crash.
No raw experiment records, provider credentials, release gates, or live adapter
qualification are changed by these SQLite checks.
