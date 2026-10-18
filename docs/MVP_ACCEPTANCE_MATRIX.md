# MVP acceptance matrix

Audit date: 2026-10-18. Audited implementation commit: `0fb0070`.

| ID | Requirement | Verification | Actual result | Evidence | Status | Remediation |
|---|---|---|---|---|---|---|
| MVP-01 | Secure Electron main/preload/renderer boundary | `npm test`, source inspection | Real Electron IPC test rejects second WebContents and data-origin mutation; sandbox/isolation/Node-disabled flags present | `tests/ipc-security.test.ts`, `src/main/main.ts` | PASS | Add subframe proof when production preload is available there |
| MVP-02 | SQLite-authoritative lifecycle and migrations | `npm test` SQLite suite | Fresh, upgrade, rollback, FK, repository, closed-database, and backup/restore cases pass | `tests/sqlite-runtime.test.ts`, `src/persistence/backup.ts` | PASS | Retention policy and active-workflow restore remain untested |
| MVP-03 | Policy and exact approvals | deterministic and SQLite tests | Invalid, prohibited, missing-capability, expiry, context mismatch, one-shot consumption cases pass | `tests/deterministic.test.ts`, `tests/sqlite-runtime.test.ts` | PASS | No live side-effect trial |
| MVP-04 | Durable dispatch and evidence provenance | execution/SQLite tests | Intent precedes adapter call; duplicate progress rejected; evidence persisted; missing capability blocks dispatch | `tests/execution.test.ts`, `src/dispatch/` | PASS | No real provider route |
| MVP-05 | Orchestrator-owned acceptance | acceptance/execution tests | Worker success stops at verification; persisted acceptance is blocked without independent review | `src/acceptance/acceptance.ts`, `experiments/results/deterministic-qualification-2026-10-18.json` | PASS | Independent review required for acceptance |
| MVP-06 | Real worker adapter qualification | OpenCode 1.19.0 CLI JSON, three durable trials | CLI JSON route executed with `opencode/mimo-v2.6-flash-free`; dispatch, real diff, verifier, and route identity persisted | `experiments/results/real-opencode-durable/`, `src/harness/opencode-cli-adapter.ts` | PROVISIONAL | SDK/server and ACP unresolved; keep route-specific qualification |
| MVP-07 | Windows ownership and verified cancellation | supported Job Object/process exercise | Not implemented or verified; no PID heuristic substituted | `docs/COMMERCIAL_PRODUCT_HANDOFF.md` | BLOCKED | Supported maintained binding plus owned-process fault tests |
| MVP-08 | Restart, crash, and uncertain recovery | deterministic crash-boundary tests | Persisted uncertainty blocks replay; restart reconciliation passes for fixture/database paths | `tests/execution.test.ts`, `tests/sqlite-runtime.test.ts` | PASS | Real worker/process recovery remains blocked |
| MVP-09 | Independent review and bounded repair | independent gold set and repair trials | No independent reviewer or repair campaign available | `docs/RESEARCH_STATUS.md` | BLOCKED | Genuine independent evaluator and frozen evaluation set |
| MVP-10 | Reproducible experiment framework | runner smoke and artifact inspection | Config, schema, immutable raw writer, and summary generator execute; corpus remains minimal | `experiments/runners/`, `experiments/config/`, `experiments/schemas/` | PASS | Add real fixture corpus and analysis when worker prerequisite exists |
| MVP-11 | Protocol comparison | CLI JSON, SDK/server, ACP trials | No candidate has comparable live evidence; unresolved, not rejected | `experiments/DECISION_REPORT.md` | BLOCKED | Qualify each available route against same contract and fixtures |
| MVP-12 | Metrics, sampling, cost, variability | trial records and protocol | Schema defines fields; no trustworthy provider cost/latency variability dataset | `docs/EXPERIMENT_PROTOCOL.md` | BLOCKED | Run three independent trials, expand as warranted |
| MVP-13 | Production build and Windows package | `npm run build`, `npm run package:win` | Both pass; package created under `out/Orchestrator-win32-x64` | `docs/VALIDATION_EVIDENCE.md` | PASS | Clean-machine launch/signing/Application Control remain untested |
| MVP-14 | Research and commercial handoff | document consistency audit | Charter, architecture, decisions, protocol, status, handoff, and decision report present and non-commercial | `docs/`, `experiments/` | PASS | Keep status tied to future evidence |

## Overall

Mandatory research-MVP evidence is incomplete. Verdict: **INCOMPLETE /
BLOCKED**. Deterministic foundation and one real CLI JSON worker route are validated;
ownership/cancellation, independent review, protocol comparison, and
commercial acceptance are not.
