# UI security results

| Check | Status | Evidence |
|---|---|---|
| Context isolation, sandbox, no renderer Node integration | PASS | `src/main/main.ts`, existing IPC test |
| Narrow typed preload surface | PASS | `src/preload/preload.ts`, `src/shared/ipc.ts` |
| Unknown task cannot run fixture | PASS | `tests/ipc-security.test.ts` |
| Tier-2/3 fixture bypass blocked | PASS | `tests/ui-core.test.ts` direct IPC calls |
| Rejected IPC preserves durable state | PASS | UI/core test; existing IPC state assertions |
| Invalid task payload rejected | PASS | existing IPC test |
| Live OpenCode route exposed to UI | NOT_APPLICABLE | Explicitly not wired by task scope |
| Subframe-specific IPC proof | UNVERIFIED | Existing main-frame/security coverage; no safe subframe test |

No privileged test endpoint or new dependency was introduced.

