# Adapter qualification

## Route

| Field | Evidence |
|---|---|
| Adapter | `opencode-cli-json` |
| Contract | `harness-adapter-v1` |
| OpenCode | `1.19.0` |
| Route | CLI `run --pure --auto --format json --model --dir` |
| Model | configured `opencode/mimo-v2.6-flash-free` |
| Provider-confirmed identity | unavailable |
| SDK/server | unresolved |
| ACP | unresolved |

## Conformance

| Check | Status | Basis |
|---|---|---|
| Manifest completeness | PASS | deterministic conformance tests |
| Route identity fidelity | INCONCLUSIVE | adapter-observed/configured identity; no provider confirmation |
| Event correlation/order | PASS | deterministic tests plus live progress traces |
| Terminal mapping | PASS | fixture mapping and live CLI outcomes |
| Cancellation ownership | BLOCKED | no supported Windows ownership mechanism |
| Deadline/restart reconciliation | BLOCKED | no verified process identity/restart trace |
| Evidence provenance | PASS | three retained diff hashes |
| Idempotent dispatch | PASS | deterministic test and retained dispatch records |
| Policy-first durable dispatch | PASS | policy tests and durable intent traces |

Supported capabilities are evidence-backed only where the table says PASS.
Missing or conditional capabilities are not assumed supported.

