# Experiment decision report

Audit date: 2026-10-18. Current evidence commit: `048c2a1`.

## Current result

The freellmapi OpenAI-compatible HTTP/SSE adapter is selected as the sole
provider baseline. The adapter targets `/v1/chat/completions` and records
structured progress, terminal outcomes, usage when reported, and fail-closed
cancellation/reconciliation status. No live endpoint trial has been run in
this checkout yet.

## Decision

Worker protocol: **OpenAI-compatible HTTP/SSE implemented**. Provider-side
cancellation ownership and restart reconciliation remain unverified.

Independent review, repair economics, real cancellation ownership, backup
restore, and nondeterministic task performance: **blocked or unmeasured**.

## Next evidence

Next evidence: configure freellmapi, run the smoke trial, verify cancellation
and restart behavior, and obtain independent review. Do not claim research-MVP
completion while those gates remain blocked.
