# Experiment results

Protocol: [experiments/README.md](../../README.md) and
[docs/EXPERIMENT_PROTOCOL.md](../../../docs/EXPERIMENT_PROTOCOL.md).

## Trial summary

| Trial | Source revision | Worker result | Verifier | Review | Acceptance | Cancellation |
|---|---|---|---|---|---|---|
| r5 | `5f2f132` | changed `value.txt` | passed | blocked | blocked | blocked |
| r6 | `5f2f132` | changed `value.txt` | passed | blocked | blocked | blocked |
| r7 | `f1958a2` | changed `value.txt` | passed | blocked | blocked | blocked |

All three used disposable versioned Git fixtures and persisted dispatch intent
before worker invocation. The identical diff proves repeatability for this
fixture only.

## Metrics

- Real-worker execution denominator: 3; successful fixture changes: 3/3.
- Verifier pass rate: 3/3.
- Acceptance rate: 0/3; all blocked by unavailable independent review.
- Cancellation verified-termination rate: unavailable; no valid denominator.
- Usage telemetry: available for r7 only. `{total:18100,input:100,output:46,
  reasoning:34,cost:0}`. r5/r6 missing fields remain unknown.
- General task reliability, latency distribution, repair economics, and cost
  generalization: not measured.
