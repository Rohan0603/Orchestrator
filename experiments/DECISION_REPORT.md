# Experiment decision report

Audit date: 2026-10-18. Audited implementation commit: `0fb0070`.

## Current result

OpenCode `1.19.0` CLI JSON is provisionally selected as first viable baseline.
Three independent durable trials used
`opencode/mimo-v2.6-flash-free` on disposable Git fixtures. Each completed
real file mutation, diff capture, deterministic verifier, and explicit blocked
acceptance. Raw records and diffs are retained under
`experiments/results/real-opencode-durable/`.

## Decision

Worker protocol: **CLI JSON provisionally supported**. SDK/server and ACP stay
unresolved, not rejected, pending comparable qualification.

Independent review, repair economics, real cancellation ownership, backup
restore, and nondeterministic task performance: **blocked or unmeasured**.

## Next evidence

Next evidence: verify supported Windows process ownership/cancellation and
obtain independent review. Do not claim research-MVP completion while those
gates remain blocked.
