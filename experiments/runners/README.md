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
