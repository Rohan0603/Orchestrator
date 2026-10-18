# Research status

Audit date: 2026-10-18. Audited implementation commit: `0fb0070`.

## Current evidence

Deterministic lifecycle, policy, route, progress, evidence, acceptance,
SQLite, restart-reconciliation, and Electron sender-boundary tests pass in the
current checkout. The local fixture reaches verification and persists a
blocked acceptance decision when independent review is unavailable.

## Blocked or unvalidated

- No live harness/provider adapter is qualified.
- Windows process ownership and verified cancellation are not qualified.
- Independent review execution and repair comparison are unavailable.
- Backup/restore, clean-machine installation, packaging, and commercial
  qualification are not established.
- Nondeterministic task economics and protocol comparisons are not measured.
- Windows packaging command passed, but clean-machine launch, signing, and
  Application Control compatibility are not validated.
- Experiment raw-record and summary runners are executable; no live trials are
  created by them without qualified prerequisites.

Do not convert this status into a release recommendation. See
`COMMERCIAL_READINESS.md` for gate tracking.

## Real-worker update

OpenCode `1.19.0` CLI JSON route is provisionally supported through
`opencode-cli-json` and free model `opencode/mimo-v2.6-flash-free`. Three
independent durable trials completed on disposable Git fixtures. All persisted
dispatch intent, real file changes, diff evidence, verifier output, and blocked
acceptance. Trial r7 also records usage telemetry.

This does not clear research-MVP completion. SDK/server and ACP are unresolved;
process ownership/cancellation and independent review remain blocked. Overall
status stays **INCOMPLETE / BLOCKED**.
