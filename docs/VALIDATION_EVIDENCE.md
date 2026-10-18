# Validation evidence

Audit date: 2026-10-18. Historical deterministic audit commit: `0fb0070`.
Current implementation/evidence commits: `5f2f132`, `f1958a2`, `048c2a1`.

Environment for current validation:

- Windows repository checkout, branch `master`
- Node `v24.19.0`, npm `12.0.2`
- Electron `44.9.0`, better-sqlite3 `12.11.1`
- `package-lock.json` SHA-256:
  `A8BDBA8A7BC3D30B7A178974608CC54D91B2FBE38DA70C20B270320BBD554315`

| Command | Exit | Result | Notes |
|---|---:|---|---|
| `npm exec tsc -- --noEmit` | 0 | PASS | No diagnostics |
| `npm test` | 0 | PASS | 26 tests: 11 deterministic, 2 conformance, 5 execution, 7 SQLite, 1 Electron IPC |
| `npm run build` | 0 | PASS | TypeScript build and renderer assets |
| `npm audit --json` | 0 | PASS | 0 critical, high, moderate, or low vulnerabilities in current install |
| `git diff --check` | 0 | PASS | No whitespace errors |
| `npm run package:win` | 0 | PASS | `out\Orchestrator-win32-x64` created with Electron 44.9.0 |
| `node experiments/runners/record-trial.mjs ...` | 0 | PASS | Wrote new blocked record to disposable temp directory |
| `node experiments/runners/summarize-results.mjs ...` | 0 | PASS | Generated summary from disposable raw record |

Electron tests emitted non-fatal GPU/network process diagnostics. They did not
fail the suite. The package command proves packaging, not clean-machine launch,
signing, Application Control compatibility, or production worker behavior.

Executed facts:

- Electron application code ran during the real IPC integration test.
- Earlier audit commands did not invoke a real worker; the later real-worker
  evidence is recorded below.
- No Windows process ownership or cancellation was verified.
- No genuinely independent review occurred.
- No task reached genuine acceptance; fixture success persisted a blocked
  acceptance decision because independent review was unavailable.

## Real-worker qualification evidence

Validated at commits `5f2f132` (adapter) and `f1958a2` (usage retention):

| Trial set | Route | Result | Evidence |
|---|---|---|---|
| r5, r6, r7 | OpenCode `1.19.0` CLI JSON / `opencode/mimo-v2.6-flash-free` | Three durable executions changed `value.txt`; verifier passed; acceptance blocked | `experiments/results/real-opencode-durable/` |

Each trial used a disposable versioned Git fixture. SQLite dispatch intent
preceded worker invocation; progress and orchestrator-verified diff evidence
were persisted. r7 recorded usage `{total:18100,input:100,output:46,reasoning:34,cost:0}`.
No trial claims independent review or cancellation. CLI JSON is provisionally
supported; SDK/server and ACP remain unresolved.

## Current checkout validation

At commit `c1fe36e` on Windows with Node `v24.19.0`, npm `12.0.2`, Electron
`44.9.0`, and `better-sqlite3` `12.11.1`:

| Command | Exit | Result |
|---|---:|---|
| `npm test` | 0 | PASS, 26/26 tests |
| `npm exec tsc -- --noEmit` | 0 | PASS |
| `npm run build` | 0 | PASS |
| `npm audit --json` | 0 | PASS, 0 critical/high/moderate/low |
| `npm run package:win` | 0 | PASS, unsigned `out\Orchestrator-win32-x64` |
| `git diff --check` | 0 | PASS |

Electron emitted non-fatal network-service diagnostics during IPC testing.
Package creation is not clean-machine launch, signing, or Application Control
evidence.
