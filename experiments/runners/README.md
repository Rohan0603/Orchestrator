# Runners

Runners accept pinned config, write new raw trial records, preserve validity
and blocking reasons, and avoid provider or repository side effects unless the
trial explicitly declares and satisfies its prerequisites.

Record a blocked prerequisite without overwriting evidence:

```text
node experiments/runners/record-trial.mjs --config experiments/config/baseline.json --output experiments/results/new-trial.json --status blocked --reason "Provider route unavailable" --source-revision <commit>
```

Regenerate a derived summary from retained raw records:

```text
node experiments/runners/summarize-results.mjs --results experiments/results --output experiments/reports/TRIAL_SUMMARY.md
```

Run real OpenCode CLI JSON adapter against disposable Git fixture:

```text
npm run build
node experiments/runners/run-opencode-cli.mjs --fixture <git-dir> --model opencode/mimo-v2.6-flash-free --output <new-json> --source-revision <commit>
```

This runner captures route identity, redacted invocation arguments, terminal
status, usage when reported, diff hash/content, verifier result, and blocked
review/acceptance status. It never claims cancellation capability.

Run through SQLite-authoritative durable dispatch in Electron:

```text
npm run build
electron experiments/runners/run-opencode-durable.mjs --fixture <git-dir> --model opencode/mimo-v2.6-flash-free --output <new-json> --source-revision <commit>
```

This path persists dispatch intent, progress, captured diff evidence, and the
orchestrator acceptance decision. It still blocks acceptance without review.
