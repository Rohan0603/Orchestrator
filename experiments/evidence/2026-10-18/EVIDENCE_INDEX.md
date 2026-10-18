# Evidence index

Evidence date: 2026-10-18  
Repository: `Rohan0603/Orchestrator`  
Branch: `master`  
Checkout: `37b5f4d` (`docs: update harness hardening evidence`)  
Platform: Windows x64; Node `v24.19.0`; npm `12.0.2`; Electron `44.9.0`;
better-sqlite3 `12.11.1`; OpenCode `1.19.0`.

## Scope

This package reconciles source, tests, retained OpenCode trials, and documented
validation. It does not create new live-worker trials, change provider
configuration, terminate processes, or claim independent review.

## Executive result

- Deterministic and UI/core suite: **PASS**, 30/30.
- Qualified real route: **PROVISIONAL**, OpenCode CLI JSON.
- Real-worker durable trials: **3 recorded; all changed the fixture and passed
  verification; all blocked at acceptance**.
- Acceptance: **BLOCKED**, no independent reviewer.
- Cancellation: **BLOCKED**, Windows process ownership is unverified.
- Release decision: **NOT READY — CRITICAL EVIDENCE MISSING**.

## Package contents

- [REQUIREMENT_TRACEABILITY.md](./REQUIREMENT_TRACEABILITY.md)
- [TEST_RESULTS.md](./TEST_RESULTS.md)
- [SECURITY_RESULTS.md](./SECURITY_RESULTS.md)
- [ADAPTER_QUALIFICATION.md](./ADAPTER_QUALIFICATION.md)
- [EXPERIMENT_RESULTS.md](./EXPERIMENT_RESULTS.md)
- [RECOVERY_RESULTS.md](./RECOVERY_RESULTS.md)
- [ACCEPTANCE_AUDIT.md](./ACCEPTANCE_AUDIT.md)
- [BLOCKERS_AND_GAPS.md](./BLOCKERS_AND_GAPS.md)
- [RELEASE_READINESS.md](./RELEASE_READINESS.md)
- [TRIAL_MANIFEST_INDEX.json](./TRIAL_MANIFEST_INDEX.json)

Fresh command-log capture was attempted during this evidence run but the
organization content policy blocked the package output path. Existing
validation records remain the source for command results; no missing log is
represented as a pass.
