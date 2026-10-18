# Experiments

This directory stores small, reproducible research artifacts. It is not a
second orchestrator.

- `config/` — pinned experiment parameters.
- `fixtures/` — controlled repositories/tasks.
- `verifiers/` — deterministic checks.
- `runners/` — entry-point notes and future runners.
- `schemas/` — versioned result shapes.
- `results/` — immutable raw trial records.
- `reports/` — derived summaries.

Raw records must never be overwritten silently. Record blocked or unavailable
prerequisites explicitly. Current deterministic qualification is run through
the repository test suite; live provider trials remain blocked until a
qualified adapter and route identity exist.
