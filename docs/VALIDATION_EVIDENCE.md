# Validation evidence

Audit date: 2026-10-26.

## Current implementation

The sole provider path is the freellmapi OpenAI-compatible HTTP/SSE adapter:

- `src/harness/openai-compatible-adapter.ts`
- `experiments/runners/run-freellmapi-smoke.mjs`
- Configuration uses `ORCHESTRATOR_OPENAI_BASE_URL`,
  `ORCHESTRATOR_OPENAI_API_KEY`, and `ORCHESTRATOR_OPENAI_MODEL`.
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
set ORCHESTRATOR_OPENAI_API_KEY=<secret>
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
