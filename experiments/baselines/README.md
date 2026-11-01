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

The 1,000 logical-worker scenario is opt-in and models 1,000 SDK worker records
and tasks in one local SQLite database. The current SDK caps active runs at 100,
so the benchmark processes the records in bounded claim/message/report batches
of at most 100 active leases. It does not launch 1,000 OS processes or make an
external-provider call. Run it explicitly with a new output path:

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
heap, database/SDK initialization, database close, isolated SQLite transaction
quantiles, one bounded SQLite busy-lock/retry probe, an event-loop delay
histogram, and one 10 ms timer-drift probe per worker scale. Timer drift is a
single sample per scale, and the histogram usually has only a few samples in
this synchronous workload; neither is a stable delay distribution.
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
not yet measure Electron renderer responsiveness, abrupt worker/backend process
crashes, provider disconnects, cancellation, storage pressure, sustained
multi-connection SQLite lock contention, peak transient queue depth, or
allocation counts. The busy probe is one 10 ms timeout conflict and a retry
after releasing the lock; it is not a sustained contention test. These need
separate runtime/fault fixtures before ORC-34 acceptance. Per-scale operation
quantiles and cross-run aggregates are descriptive; small sample counts do not
establish stable distributions or capacity.

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

## Earlier repeated trials and 1,000 logical workers — 2 November 2026

Three fresh runs used the same source `HEAD` (`2ce2a1e44a4caf28850b46fecde1e498fe7fda8e`),
the same tracked-diff SHA-256 (`76d85e4d53eea8e2008e703fb4b634ccb27fc7d14ba07b7ff6b4bed17e7bbdce`),
Windows 11 x64 build 26200, Node 24.22.0, Electron 44.9.3, and 3 progress
messages per logical worker:

* `ts-baseline-repeat-trial-02-20261102.json`
* `ts-baseline-repeat-trial-03-20261102.json`
* `ts-baseline-repeat-trial-04-20261102.json`

The table reports min / median / max across those three independent runs.
Latency p50/p95 values are the median of each run's operation quantiles; these
are descriptive, with no inferential confidence interval. RSS is the median
per-run RSS delta. Timer drift is one 10 ms timer probe per scale and mostly
captures synchronous workload blocking; it is not an event-loop-delay
distribution.

| Logical workers | Total workload ms | Aggregate ops/s | Report + review p50 ms | Report + review p95 ms | RSS delta MiB | DB MiB | Timer drift ms |
| --: | --: | --: | --: | --: | --: | --: | --: |
| 1 | 87.9 / 96.0 / 147.8 | 74.4 / 114.5 / 125.2 | 19.86 / 20.00 / 33.16 | 19.86 / 20.00 / 33.16 | 7.0 | 0.42 | 147.4 / 155.7 / 214.2 |
| 10 | 895.6 / 899.6 / 976.7 | 112.6 / 122.3 / 122.8 | 16.35 / 17.04 / 19.76 | 22.52 / 29.52 / 30.20 | 4.6 | 0.72 | 916.4 / 973.8 / 991.3 |
| 100 | 9,006.1 / 9,632.5 / 9,660.2 | 113.9 / 114.2 / 122.1 | 17.90 / 19.01 / 20.14 | 23.50 / 24.14 / 27.32 | 8.0 | 4.14 | 9,017.3 / 9,652.6 / 9,684.0 |

The 1,000-logical-worker trial is retained separately as
`ts-baseline-1000-workers-trial-01-20261102.json`. It created 1,000 worker
records and 1,000 tasks, then processed them in 10 claim/message/report
batches capped at the current SDK limit of 100 active runs. It took 122,505.3
ms, contributed 89.8 aggregate measured operations/s, used a 39,063,552-byte
database, and increased RSS by about 115.8 MiB. Correctness passed for all
1,000 tasks/runs, 3,000 progress rows, 1,000 reports, 1,000 acknowledged
review requests, 3,000 idempotent duplicate replays, and zero pending
deliveries. This measures bounded logical records; it is not 1,000 concurrent
workers or external processes.

All results remain synthetic, local SDK/SQLite measurements. They do not
establish production capacity or an SLA. The broader runtime/fault and Electron
responsiveness gaps listed above remain open for ORC-34.

## Instrumented repeated trials and 1,000 logical workers — 2 November 2026

Three repeat runs used the same source `HEAD` (`2ce2a1e44a4caf28850b46fecde1e498fe7fda8e`),
tracked-diff SHA-256 (`9176810c2be603d9f77fe55e5385383b8f8a3dc7da6760ac836d0638e4c08a14`),
Windows 11 x64 build 26200, Node 24.22.0, Electron 44.9.3, and three progress
messages per worker:

* `ts-baseline-instrumented-trial-03-20261102.json`
* `ts-baseline-instrumented-trial-04-20261102.json`
* `ts-baseline-instrumented-trial-05-20261102.json`

The first two instrumented diagnostic runs are also preserved:
`ts-baseline-instrumented-trial-01-20261102.json` and
`ts-baseline-instrumented-trial-02-20261102.json`. Trial 01 predates the event
loop yield adjustment and has no histogram samples; trial 02 has too few samples
for the smallest scale. They are not included in the three-run aggregate.

The table shows min / median / max across the three runs. Operation latency
quantiles and isolated transaction quantiles are the median of the three
per-run quantiles. The busy-lock wait is one conflict per scale and is sensitive
to host scheduling; the configured SQLite timeout is 10 ms. Timer drift is one
sample and the event-loop histogram has only three samples per run, so these
figures do not estimate a stable p95/p99 event-loop distribution.

| Workers | Total ms | Aggregate ops/s | Report + review p50 / p95 ms | Immediate SQLite transaction p50 / p95 ms | Busy wait ms | DB init / close ms (median) | Timer drift ms | Event-loop histogram p95 ms (median) | RSS delta MiB (median) | DB MiB |
| --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| 1 | 82.0 / 84.1 / 86.8 | 138.2 / 142.7 / 146.3 | 17.54 / 17.54 | 2.50 / 2.94 | 59.3 (51.9–78.6) | 24.55 / 1.08 | 469.0 / 483.9 / 513.2 | 18.83 | 1.03 | 0.42 |
| 10 | 795.6 / 818.0 / 825.7 | 134.4 / 135.7 / 139.5 | 16.48 / 22.32 | 2.54 / 3.04 | 65.2 (57.5–66.5) | 16.18 / 1.54 | 1,150.1 / 1,173.1 / 1,184.9 | 25.17 | 3.80 | 0.72 |
| 100 | 8,052.8 / 8,192.1 / 8,335.8 | 132.1 / 134.4 / 136.7 | 16.77 / 19.84 | 2.59 / 3.09 | 55.1 (50.3–60.6) | 22.29 / 3.71 | 8,424.4 / 8,553.1 / 8,740.9 | 17.56 | 12.54 | 4.14 |

Each scale also passed a single explicit writer conflict: the contender received
`SQLITE_BUSY`, then inserted successfully after the owner released its
`BEGIN IMMEDIATE` lock. The benchmark measured 100 isolated transaction samples
per scale. The 1,000-worker run below measured 1,000 transaction samples.

Raw instrumented 1,000-worker artifact:
`ts-baseline-instrumented-1000-workers-trial-01-20261102.json`. It ran 1,000
logical workers in 10 batches capped at 100 active runs; total workload was
122,251.1 ms at 90.0 aggregate measured operations/s. It recorded 1,000
isolated transaction samples (p50 2.56 ms, p95 3.34 ms, p99 4.02 ms), one
`SQLITE_BUSY` and one successful retry, 39,030,784 bytes for the main database,
9.44 ms main database close time, and about 124.1 MiB RSS increase. Correctness
passed for all 1,000 tasks/runs, 3,000 progress rows, 1,000 reports, 1,000
acknowledged review requests, 3,000 idempotent replays, and zero pending
deliveries. This remains a synthetic bounded-record workload, not 1,000
concurrent workers or service capacity.

ORC-34 remains In Progress. Full Electron responsiveness, sustained SQLite
contention/storage pressure, allocation counts, provider disconnect, real
process/backend crash recovery, cancellation, and recovery-duration workloads
still need separate fixtures and evidence.

The canonical `npm run benchmark:baseline` rerun on the reviewed harness exited
0 and retained `ts-baseline-2026-11-01T20-25-00.478Z-24620.json`; correctness
passed at 1/10/100 logical workers.

## Clean-close lease-expiry recovery probe — 2 November 2026

Raw artifact: `ts-baseline-2026-11-01T20-40-08.012Z-31796.json` (latest combined
run; the initial standalone probe is also preserved as
`ts-baseline-2026-11-01T20-29-15.489Z-23140.json`). Command:
`npm run benchmark:baseline` (exit 0; one Electron benchmark test, correctness
passed at 1/10/100 logical workers). This probe creates a one-millisecond SDK
lease, cleanly closes SQLite, waits for expiry, reopens SQLite and constructs a
new SDK instance, then attempts to claim work. The latest combined run measured
database reopen at 4.16 ms, SDK construction at 0.03 ms, and expiry
reconciliation/claim at 7.06 ms in this single host-sensitive sample. It
verified one run remained `recovery_required`, its
recovery record remained `recovery_required`, and no replacement run was
created. This measures clean database close/reopen recovery, not abrupt process
termination or production restart safety; it is not a stable latency estimate.

The immediately preceding diagnostic artifact
`ts-baseline-2026-11-01T20-28-38.598Z-13080.json` is preserved, but excluded
from analysis because its `sdkReadyMs` field captured database reopen only and
was mislabeled. The harness and subsequent artifact split database reopen from
SDK construction explicitly.

## Synthetic provider disconnect probe — 2 November 2026

Raw artifact: `ts-baseline-2026-11-01T20-40-08.012Z-31796.json` (the earlier
standalone run `ts-baseline-2026-11-01T20-31-41.110Z-24996.json` is preserved).
The same
`npm run benchmark:baseline` run passed its 1/10/100 workload correctness
checks and injected a fake fetch response that emitted partial content before
throwing a synthetic stream disconnect. No socket or real provider was used.
The latest combined run completed in 66.45 ms; the SDK stored the run as
`rejected`, emitted `started`, `delta`, `completed`, and created no acceptance
decision. This covers local adapter handling of a transport interruption, not
live provider disconnect/reconnect behavior or provider-side cancellation.
The artifact also contains another clean-close lease-expiry probe; its results
are single-run descriptive timings only.

## Native owned-process cancellation probe — 2 November 2026

Raw artifact: `ts-baseline-2026-11-01T20-40-08.012Z-31796.json` (standalone
run `ts-baseline-2026-11-01T20-33-35.524Z-16700.json` is also preserved). Command:
`npm run benchmark:baseline` (exit 0). On Windows, the harness launches the
existing native ownership helper's worker/child/grandchild fixture, waits until
all three processes have created their start markers, then times verified Job
Object cleanup. The latest combined run measured 1.16 ms and verified zero
active processes after cancellation. This is one host-local sample for one process tree; it is
not an SDK-wide cancellation command, repeated distribution, or concurrent
cancellation storm. The v0.1 one-active-worker constraint remains in force.

## SQLite storage-pressure probe — 2 November 2026

The latest combined artifact above also caps a disposable database at eight
pages above its schema size, writes 16 KiB blobs transactionally, and asserts
that SQLite returns `SQLITE_FULL` without damaging database integrity. This
run committed two rows (32 KiB of payload), reached the 109-page cap from 101
pages, and completed the pressure loop in 9.86 ms; `integrity_check` returned
`ok`. The database is temporary and isolated. This is SQLite page-limit
simulation, not OS-level disk exhaustion. Repeated sustained lock contention
and real disk-full behavior remain unmeasured.

## Bounded sustained SQLite lock probe — 2 November 2026

The latest combined artifact also holds `BEGIN IMMEDIATE` on one connection
while a second connection makes ten writes with a 10 ms busy timeout. All ten
returned `SQLITE_BUSY`; p50/p95 wait was 66.57/74.60 ms on this Windows host.
After releasing the lock, one explicit retry committed, and the database
contained exactly one row. This is a single bounded contention run; Windows
scheduling makes measured waits longer than the configured timeout. It does
not model an extended or production multi-writer workload.

ORC-34 remains In Progress. Open measurements: renderer responsiveness under
backend load; full Electron startup/readiness; abrupt worker/backend process
crash and restart; live provider disconnect/reconnect and remote cancellation;
concurrent cancellation stress; extended SQLite lock contention; OS-level disk
pressure; peak queue depth and allocation counts; and repeated recovery and
cancellation distributions.
