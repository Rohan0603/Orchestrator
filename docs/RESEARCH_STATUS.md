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

- OpenCode CLI JSON is provisionally qualified; SDK/server and ACP remain
  unqualified.
- Windows process ownership and verified cancellation are not qualified.
- Independent review execution and repair comparison are unavailable.
- Backup/restore integrity now passes for a disposable SQLite database;
  retention, active-workflow restore, clean-machine installation, packaging,
  and commercial qualification are not established.
- Nondeterministic task economics and protocol comparisons are not measured.
- Windows packaging command passed, but clean-machine launch, signing, and
  Application Control compatibility are not validated.
- Experiment raw-record and summary runners are executable; three live durable
  CLI JSON trials are retained under `experiments/results/real-opencode-durable/`.

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
