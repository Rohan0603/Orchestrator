# Experiment protocol

## Trial identity

Each trial records experiment ID, hypothesis, replicate, source commit,
fixture snapshot, lockfile hash, adapter/route identity, configuration and
verifier versions, prerequisites, timestamps, outcome, acceptance decision,
review result, repair count, usage/cost provenance, intervention, artifacts,
and validity/exclusion reason.

## Validity

Use the same task, fixture, acceptance criteria, verifier, and worker
configuration when comparing one factor. Keep raw trial records immutable.
Separate `accepted`, `failed`, `blocked`, `inconclusive`, `invalid`, and
`excluded`. Do not treat unavailable telemetry as zero.

## Sequence

1. Run deterministic safety and lifecycle qualification.
2. Run three independent nondeterministic baseline trials where prerequisites
   exist; expand when variability or decision risk warrants.
3. Compare protocol candidates only where real semantics are available.
4. Compare independent review and at most two repair cycles.
5. Exercise controlled restart/recovery and approval fault cases.
6. Report denominators, variability, uncertainty, hard-gate failures, and
   blocked prerequisites.

No experiment result is inferred from a mock or from source inspection.
