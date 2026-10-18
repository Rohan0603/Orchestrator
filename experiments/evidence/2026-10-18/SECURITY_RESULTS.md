# Security results

## Passed evidence

- Renderer security tests pass: sandbox/context isolation/IPC boundary coverage
  is included in the 30-test baseline.
- Dispatch policy and approval checks fail closed in deterministic tests.
- Capability manifest validation rejects duplicate and incomplete declarations.
- OpenCode adapter rejects `.cmd` execution and does not use shell execution
  for the resolved executable route.
- Malformed or oversized JSON is inconclusive, not success.
- Progress and stderr diagnostics are bounded.
- Unknown telemetry remains `null`; missing usage is not fabricated as zero.
- No PID/name-based termination is used.

## Unresolved

- Windows Job Object ownership and verified termination are unavailable.
- No independent security review was performed.
- Package is unsigned; Application Control compatibility is untested.
- Provider-confirmed model identity is unavailable.

No secrets or credential values are included in retained records reviewed here.
