# Test results

Source: [docs/VALIDATION_EVIDENCE.md](../../../docs/VALIDATION_EVIDENCE.md).
Commands ran from repository root on Windows x64.

| Check | Exit | Result | Scope and limitation |
|---|---:|---|---|
| `npm test` | 0 | PASS | 30 tests: 11 deterministic, 4 conformance, 5 execution, 8 SQLite, 1 IPC, 1 UI/core |
| `npm exec tsc -- --noEmit` | 0 | PASS | Type-check only |
| `npm run build` | 0 | PASS | TypeScript build and renderer assets |
| `npm audit --json` | 0 | PASS | 0 reported vulnerabilities |
| `npm run package:win` | 0 | PASS | Unsigned package created |
| `git diff --check` | 0 | PASS | Whitespace check |

The package command does not prove clean-machine launch, signing,
Application Control compatibility, or worker behavior. Electron emitted
non-fatal GPU/network diagnostics during tests.

Fresh per-command logs were not retained because package-path creation was
blocked by organization content policy. This is a documentation limitation,
not a test pass.

Runner safety: `scripts/run-electron-tests.mjs` now cleans up only the exact
spawned `ChildProcess` handle. It does not infer ownership from parent-PID
relationships or force-terminate descendants. This is test-runner hygiene, not
Windows Job Object qualification.
