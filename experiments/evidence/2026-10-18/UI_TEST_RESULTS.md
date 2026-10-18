# UI test results

Environment: Windows x64, Node `v24.19.0`, npm `12.0.2`, Electron `44.9.0`.

| ID | Command/test | Expected | Actual | Status |
|---|---|---|---|---|
| UI-01 | `npm test` | Existing suites plus UI/core test pass | 30/30 pass: 11 deterministic, 4 conformance, 5 execution, 8 SQLite, 1 IPC, 1 UI/core | PASS |
| UI-02 | `node scripts/run-electron-tests.mjs --expected=1 dist-test/tests/ui-core.test.js` | Renderer flow and risk gates pass | UI/core test passed | PASS |
| UI-03 | `npm exec tsc -- --noEmit` | No diagnostics | Exit 0 | PASS |
| UI-04 | `npm run build` | Build succeeds | Exit 0 | PASS |
| UI-05 | `git diff --check` | No whitespace errors | Exit 0 | PASS |

Reproduction:

```powershell
npm test
npm exec tsc -- --noEmit
npm run build
git diff --check
```

No UI automation dependency was added. Test uses existing Electron test
infrastructure and a temporary renderer directory.

