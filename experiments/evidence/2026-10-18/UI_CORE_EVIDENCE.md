# UI/core evidence

## Scope

The renderer uses typed preload IPC only. Live OpenCode remains intentionally
outside UI scope. Fixture UI labels explicitly state that runs are deterministic
and do not invoke a provider.

## Verified behavior

- Startup status reaches `Database: connected` in an actual Electron renderer.
- Renderer task submission creates a task, then resets title and criterion.
- Submit handler disables itself while its IPC request is pending and restores
  state in `finally`.
- Fixture run button disables per task while pending; repeated clicks do not
  create duplicate runs.
- Fixture success is shown separately from acceptance; the tested run reports
  `accepted: false` because independent review is unavailable.
- Tier-2 and tier-3 tasks remain visible as approval-required/unavailable and
  direct fixture IPC calls return `APPROVAL_REQUIRED` without creating runs.
- Renderer catches rejected status, task-list, task-creation, history, and
  fixture IPC promises with user-safe messages.

## Changed files

| File | SHA-256 |
|---|---|
| `src/renderer/renderer.ts` | `0FAC7B7E6510A42D83A19D0002C3BB227E78450A3859276C406A7748189EF2D1` |
| `tests/ui-core.test.ts` | `B40881A696E6F4B2C054BB312E2A33BC33A8EBCF9FC40FF7F8FDD7A4A823F975` |
| `package.json` | `6FD74651A8A89D1D154B2B4BF79045312956A5B9D7B872063516C85D890121A3` |
