# Research status

Audit date: 2026-10-18. Audited implementation/evidence commit: `c1fe36e`.

## Current evidence

Deterministic lifecycle, policy, route, progress, evidence, acceptance,
SQLite, restart-reconciliation, and Electron sender-boundary tests pass in the
current checkout. The local fixture reaches verification and persists a
blocked acceptance decision when independent review is unavailable.

The Electron test runner cleanup path now terminates only its directly spawned
child handle; recursive parent-PID discovery and forced descendant termination
were removed. This improves test-process safety but does not qualify run-owned
worker cancellation.

## Blocked or unvalidated

- freellmapi OpenAI-compatible HTTP/SSE is implemented but not live-qualified.
- Windows process ownership and verified cancellation are not qualified.
- Independent review execution and repair comparison are unavailable.
- Backup/restore integrity now passes for a disposable SQLite database;
  retention, active-workflow restore, clean-machine installation, packaging,
  and commercial qualification are not established.
- Nondeterministic task economics and protocol comparisons are not measured.
- Windows packaging command passed, but clean-machine launch, signing, and
  Application Control compatibility are not validated.
- Experiment raw-record and summary runners are executable; the freellmapi smoke
  runner is pending a configured endpoint.

Do not convert this status into a release recommendation. See
`COMMERCIAL_READINESS.md` for gate tracking.

## Real-worker update

The freellmapi OpenAI-compatible adapter is implemented through
`src/harness/openai-compatible-adapter.ts`. It has deterministic parser and
streaming tests, but no configured endpoint trial has completed.

This does not clear research-MVP completion. Provider-side cancellation,
restart reconciliation, artifact provenance, and independent review remain
blocked. Overall status stays **INCOMPLETE / BLOCKED**.

## Completion attempt — 2026-10-26

The current checkout now has zero npm audit findings under Electron `44.9.3`.
The native ownership fixture completed its local process-tree qualification.
This does not qualify freellmapi provider-side ownership or cancellation.

This is stronger runtime evidence, but not commercial acceptance: the primary
execution still ended in `recovery_required` at the deadline, the production
manifest remains conservative, and no independent reviewer was available.
Restart reconciliation for a real provider, protocol comparison, clean-machine
installation, signing/Application Control, and independent review remain
blocked or unvalidated.

## Blocker follow-up — current pass

The native ownership fixture remains separate from the freellmapi HTTP adapter.
Provider session-level restart reconciliation remains unimplemented by design:
the generic API does not provide a qualified status/reconnect contract.

## Provider replacement update — 2026-10-26

The current implementation target is freellmapi through the generic
OpenAI-compatible `/v1/chat/completions` route. The new adapter supports
streamed progress, terminal outcomes, usage capture, local request abort, and
secret-safe environment configuration. No freellmapi endpoint was configured
in this workspace during the implementation pass, so live endpoint behavior,
remote cancellation, restart reconciliation, and artifact provenance remain
unverified. No alternate provider or client route is retained in the current
implementation.
