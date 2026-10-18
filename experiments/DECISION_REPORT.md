# Experiment decision report

## Current result

No live experiment comparison has been completed. Deterministic tests support
the lifecycle safety hypotheses for the implemented fixture path, but they do
not select OpenCode CLI JSON, SDK/server, or ACP.

## Decision

Worker protocol: **unresolved**. Live qualification is blocked by missing
qualified adapter/provider evidence and must not be replaced with synthetic
success.

Independent review, repair economics, real cancellation ownership, backup
restore, and nondeterministic task performance: **blocked or unmeasured**.

## Next evidence

Qualify one real adapter against `harness-adapter-v1`, verify provider/model
identity and mandatory capabilities, then run the pinned baseline before
comparing protocols or review/repair arms.
