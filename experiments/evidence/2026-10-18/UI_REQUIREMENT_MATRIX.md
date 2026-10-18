# UI requirement matrix

| Requirement | Implementation | Test/evidence | Status |
|---|---|---|---|
| Startup status truthful | `renderer.ts` status handling | UI-01, UI-02 | PASS |
| Task title/criterion UI validation | HTML required/maxlength plus main parser | UI-01, IPC test | PASS |
| Backend validation authoritative | `parseCreateTaskInput` | IPC test | PASS |
| Failed create preserves input | renderer resets only on success | source inspection; rejection path not runtime-tested | UNVERIFIED |
| Submit race prevention | `submittingTask` and `finally` | UI-02 source/runtime | PASS |
| Fixture pending race prevention | `pendingFixtureRuns` and disabled button | UI-02 | PASS |
| Tier messaging truthful | risk-tier notes and fixture gate | UI-02, UI security report | PASS |
| Run/acceptance separation | result message and core summary | UI-02, ACC-01..03 | PASS |
| History query error visible | renderer error branch | source inspection only | UNVERIFIED |
| History across restart | SQLite/core coverage, not UI reload | SQLite tests | UNVERIFIED |
| Renderer error/rejected IPC paths | explicit catches added | source inspection; no faulted renderer IPC harness | UNVERIFIED |
| Real worker through UI | no route wired | scope constraint | NOT_APPLICABLE |

