# Research charter

## Purpose

Orchestrator is a local, single-user research MVP for testing whether a
durable orchestrator can manage coding work from intake through evidence-based
acceptance. It is not a commercial or production-ready product.

## Research questions

- Can durable policy, dispatch, evidence, review, repair, and recovery state
  prevent unsafe or duplicate work?
- Which worker interface can satisfy the versioned adapter contract?
- Does independent review improve accepted-task quality?
- Does bounded repair justify added cost and latency?
- Which approval, ownership, and persistence controls are mandatory?

## Hypotheses

H1. Acceptance owned by the orchestrator and gated on verified evidence is safer
than trusting worker terminal success.

H2. Persisted dispatch intent plus explicit uncertain recovery prevents unsafe
automatic replay after interruption.

H3. Mandatory capability and route identity checks prevent unqualified worker
dispatch.

H4. Independent review and bounded repair may improve correctness, but their
benefit must be measured against added latency, cost, and intervention.

## Success conditions

Every accepted trial must pass correctness, scope, safety, deterministic
verification, review, and evidence gates. Hard-gate failures cannot be offset
by favorable averages. Missing provider telemetry, process ownership, or
independent review is reported as unavailable or blocked.
