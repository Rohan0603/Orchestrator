# Real Provider Ownership Review Package

Status: **implementation checkpoint; review required before acceptance**

Scope: review only the native helper protocol and OpenCode adapter ownership
boundary. Do not treat this package as production-provider qualification.

## Review objective

Determine whether every OpenCode process is launched, observed, cancelled, and
reconciled through the native Windows Job Object owner, with no direct provider
spawn or unsafe fallback.

## Changed surfaces

- `native/job-object-helper/job_object_helper.cpp`
  - Validated absolute executable and working directory.
  - Structured argument and controlled environment transport.
  - Explicit inherited-handle allowlist for worker stdout/stderr; helper
    protocol handles are not inherited.
  - Suspended launch, Job Object assignment, membership verification, then
    resume.
  - Named Job Object and bounded recovery event support for restart
    reconciliation.
  - Inherited stdout/stderr pipes and correlated output events.
  - Exit-code reporting and verified Job Object cleanup.
- `src/execution/native-ownership.ts`
  - Typed generic owned-process launch.
  - Correlated output transport.
  - Exit-status reporting.
  - Explicit process-count verification and output-drain status.
  - Worker PID and creation-time transport.
  - Durable uncertainty remains fail-closed.
- `src/harness/adapter-contract.ts`
  - Centrally owned mandatory real-provider capability requirements.
- `src/harness/opencode-cli-adapter.ts`
  - Route identity is derived and reported by adapter-owned provider/model
    state; qualification runners no longer construct it.
- `src/persistence/run-repository.ts` and `src/persistence/migrations.ts`
  - Durable worker identity fields for recovery evidence.
  - Run state changes and corresponding audit events commit atomically.
  - Startup recovery outcome persistence is idempotent and auditable.
- `src/harness/opencode-cli-adapter.ts`
  - Direct `spawn()` path removed.
  - OpenCode launch routed through `NativeOwnershipCoordinator`.
  - Cancellation uses verified owner cleanup.
  - Owner loss becomes inconclusive, not success.
- `tests/native-ownership.test.ts`
  - Generic output/cancellation.
  - Unsafe specification rejection.
  - Provider exit-status observation.
  - Worker output cannot forge helper protocol responses.
  - Matching/mismatched identity restart reconciliation and unrelated-process
    preservation.
- `package.json`
  - Native ownership expected test count updated to 10.

## Required reviewer checks

1. Confirm no OpenCode direct process launch remains.
2. Confirm executable, argument, working-directory, and environment validation
   cannot be bypassed through protocol strings.
3. Confirm Job Object assignment occurs before resume on every provider path.
4. Confirm stdout/stderr transport cannot impersonate a response or cross
   correlation boundaries.
5. Confirm helper crash, provider crash, ambiguous launch, cancellation timeout,
   and application restart remain inconclusive/recovery-required.
6. Confirm non-zero provider exit cannot become successful acceptance.
7. Confirm fixture ownership behavior and IPC security behavior remain
   unchanged.

## Reproducible checks already run

```text
npm run build:native-helper                         PASS
npm exec tsc -- --noEmit                            PASS
npm exec tsc -- -p tsconfig.test.json               PASS
native-ownership.test.js (10 tests)                PASS
execution.test.js (9 tests)                         PASS
owned-fixture.test.js (1 test)                      PASS
conformance.test.js (4 tests)                       PASS
```

Electron emitted non-fatal Chromium cache/GPU diagnostics during Electron
tests. Test processes exited successfully.

## Explicitly not accepted by this package

- Real OpenCode provider execution.
- Real-provider cancellation and restart/recovery qualification.
- Packaged-provider qualification.
- Independent review or acceptance.
- GO verdict.

Reviewer findings must be addressed and retested before changing capability
manifest states or enabling production live-worker dispatch.

## Post-remediation checkpoint

The acceptance path now derives criteria, deterministic-check, and completeness
from acceptable durable evidence correlated to the dispatch attempt. The
qualification runners derive capability and prerequisite flags from the adapter
manifest and report cancellation state from that manifest; they no longer
assert those qualification values.

Latest local validation: `npm test`, `npm run build`, both TypeScript checks,
and `git diff --check` passed. This remains self-validation only. Independent
OpenCode CLI review is still required.

The helper now uses one validated launch implementation for fixture and generic
requests, explicit controlled environment state, explicit process-count
verification, output-drain reporting, and worker identity transport. Mandatory
real-provider capability requirements are centrally defined and include
cancellation ownership and restart reconciliation. These changes remain
unqualified until independently reviewed and exercised with a real provider.

## Live-slice attempt

The native OpenCode binary was available and an Electron-hosted disposable
slice was attempted through this route. Provider launch did not produce a
successful terminal/artifact result; the attempt is **failed/inconclusive**.
No live-provider capability is accepted from it.
