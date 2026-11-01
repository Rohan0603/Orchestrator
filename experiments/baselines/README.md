# TypeScript backend migration baseline

`tests/baseline-benchmark.test.ts` is the first repeatable local baseline for
ORC-34. It runs the current SDK against SQLite under Electron's Node runtime,
checks lifecycle and durable review-delivery invariants before retaining timing
results, and writes each raw run to a new JSON path under this directory.

Run after building the native helper and compiling the Electron-targeted test
program:

```powershell
npm run build:native-helper
npx tsc -p tsconfig.test.json
node scripts/run-electron-tests.mjs --expected=1 --timeout=600000 dist-test/tests/baseline-benchmark.test.js
```

Optional configuration uses environment variables:

* `ORCHESTRATOR_BASELINE_WORKERS=1,10,100` selects bounded default scales.
* `ORCHESTRATOR_BASELINE_PROGRESS_MESSAGES=3` selects progress messages per worker.
* `ORCHESTRATOR_BASELINE_OUTPUT=<new-json-path>` selects a unique raw output path.

The 1,000 logical-worker scenario is opt-in and models 1,000 SDK worker records,
1,000 tasks, and at most 1,000 active leases in one local SQLite database; it
does not launch 1,000 OS processes or make an external-provider call. Run it
explicitly with a new output path:

```powershell
$env:ORCHESTRATOR_BASELINE_WORKERS='1,10,100,1000'
$env:ORCHESTRATOR_BASELINE_OUTPUT='experiments/baselines/ts-baseline-logical-1000-trial-01.json'
node scripts/run-electron-tests.mjs --expected=1 --timeout=600000 dist-test/tests/baseline-benchmark.test.js
```

The output is created with exclusive `wx` mode. Reusing an existing path fails
instead of replacing a previous experiment record.

The default workload models SDK worker registrations, task creation, claims,
lease heartbeats, ordered progress messages, idempotent duplicate replays,
terminal reports, artifact references, and synchronous `review.requested`
delivery. It uses zero external worker processes. A correctness mismatch fails
the run before it writes evidence. Result files include source revision, host,
runtime, database file size, command latency quantiles, throughput, CPU, RSS,
heap, and one 10 ms timer-drift probe per worker scale. Timer drift is a single
sample per scale, so it is not represented as a p95/p99 distribution.
Each result also records `HEAD`, whether the worktree was dirty, the exact
status paths, and a SHA-256 of the tracked diff from `HEAD`; this identifies the
measured source state when the benchmark runs with local changes. Hashes cover
untracked source/evidence files; the explanatory baseline index is omitted to
avoid making the evidence hash stale whenever this summary is updated.
Each operation's `operationsPerSecondContribution` is its operation count
divided by the full workload duration; it is not independently timed phase
throughput. `throughput.allMeasuredOperationsPerSecond` is the aggregate across
all measured operation classes over that same full workload duration.

These measurements are synthetic local baseline data, not service capacity or
SLA claims. Logical workers are database-backed worker records. SDK command
latency includes the synchronous SQLite and orchestration work inside each
command; it does not isolate SQLite transaction time. The first harness does
not yet measure Electron renderer responsiveness, real worker/backend crash
recovery, provider disconnects, cancellation, storage pressure, SQLite lock
contention, peak transient queue depth, or allocation counts. Those need
separate runtime/fault fixtures before the ORC-34 acceptance criteria can be
considered complete. The current evidence is one run per scale. It does not
estimate run-to-run variance, and quantiles from small samples (especially the
one-worker case) are descriptive only, not stable distribution estimates.

## Latest bounded run — 2 November 2026

Raw artifact: `ts-baseline-2026-11-01T19-49-46.455Z-8912.json`. It records
Windows 11 x64 (build 26200), AMD Ryzen 5 4600H, Node 24.22.0, Electron
44.9.3, and a 12-core/16-GB host. Source `HEAD` was
`4982678cd2f16d3ce6355ebdaf5eb6801ffe5e23`; the worktree was dirty and its
tracked-diff SHA-256 is
`596da6a75287cafed882f546a60b3f90414cc81fb54c882930285eb4bf9b0c47`. The
raw artifact also lists and hashes every untracked source/evidence file.

| Logical workers | Total workload (ms) | Aggregate measured operations/s | Report + inline review p50 / p95 / p99 (ms) | RSS delta (MiB) | DB file (MiB) | Timer drift (ms) |
| --: | --: | --: | --: | --: | --: | --: |
| 1 | 89.4 | 123.1 | 20.17 / 20.17 / 20.17 | 6.66 | 0.42 | 152.8 |
| 10 | 833.4 | 132.0 | 17.12 / 22.44 / 22.44 | 4.95 | 0.72 | 846.8 |
| 100 | 8,382.1 | 131.2 | 16.00 / 19.25 / 24.97 | 10.66 | 4.14 | 8,391.4 |

Correctness passed at every scale: every task had one run in `verification`,
all progress and reports persisted, one review request per report was
acknowledged, pending delivery depth was zero, and each duplicate progress
replay resolved to the original message. `npm run benchmark:baseline` exited
0 with 1/1 benchmark test in 9.98 seconds inside the runner. Small-sample
quantiles and one-run timer drift are descriptive observations only. Earlier
raw trials remain preserved beside this artifact.
