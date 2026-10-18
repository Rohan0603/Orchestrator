# Final research validation

Audit date: 2026-10-18. Audited implementation commit: `0fb0070`.

## Evidence inventory

The deterministic qualification record covers 26 passing tests. Three live
OpenCode CLI JSON trials are retained below; their task acceptance remains
blocked because independent review is unavailable.

## Hypothesis outcomes

| Hypothesis | Status | Evidence and limitation |
|---|---|---|
| H1: orchestrator-owned verified acceptance is safer | Provisionally supported | Fixture path blocks worker-only success; no comparative live arm |
| H2: durable intent plus uncertain recovery prevents unsafe replay | Provisionally supported | Deterministic crash/restart tests pass; no real worker side effect |
| H3: mandatory capability/identity checks block unsafe routes | Provisionally supported | Contract and execution tests pass; no live route |
| H4: review/repair improves quality enough to justify cost | Blocked | No independent reviewer, repair campaign, or telemetry |
| Protocol choice: CLI JSON vs SDK/server vs ACP | Unresolved | No fair live comparison; prerequisites unavailable |

## Sampling and economics

Nondeterministic trial minimum was not met because no qualified live worker
route exists. Cost is unavailable, not zero. Latency and variability are not
reported as measured research results.

## Conclusion

The deterministic foundation is credible for its tested fixture boundary.
Research MVP completion, commercial architecture selection, and universal
performance claims are not supported. Next decision-changing evidence is a
qualified real adapter followed by pinned baseline and comparison trials.

## Real-worker addendum

Three durable trials now qualify one baseline route:
OpenCode `1.19.0` CLI JSON with `opencode/mimo-v2.6-flash-free`. All three
persisted dispatch intent, executed real worker code, changed the fixture,
captured diff evidence, and passed the deterministic verifier. Acceptance was
blocked in every trial because no independent reviewer was configured. Trial
r7 records usage telemetry and cost `0` as provider-reported, not universal
zero cost.

Updated conclusion: CLI JSON is **provisionally supported**. SDK/server and ACP
remain unresolved; cancellation/process ownership and independent review keep
the research MVP **INCOMPLETE / BLOCKED**.
