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

Run the generic freellmapi/OpenAI-compatible smoke trial. This requires a
running freellmapi endpoint and keeps the API key out of the trial record:

```text
npm run build
set ORCHESTRATOR_OPENAI_BASE_URL=http://127.0.0.1:31415/v1
set ORCHESTRATOR_OPENAI_API_KEY=<secret>
set ORCHESTRATOR_OPENAI_MODEL=auto
node experiments/runners/run-freellmapi-smoke.mjs --output <new-json> --source-revision <commit>
```

The smoke trial validates the generic `/chat/completions` request, SSE parsing,
usage capture, and terminal outcome only. It does not qualify remote
cancellation ownership, artifact provenance, or restart reconciliation.
