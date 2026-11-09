# Orchestrator — GitHub Chief/Worker development workflow (2026-11-09)

> This additive section supersedes the **legacy Linear task-tracking and executor-label** sections that appear below. All architectural boundaries for the **Orchestrator product itself** (lease-owned work, secure MCP tools, Electron IPC isolation, recovery, evidence/acceptance, Windows packaging and product-internal agent execution) remain in force. This is repository **development governance**, not a mandate to disable the Orchestrator product's agents.

- **Project management:** GitHub repository Issues + a specifically selected, live-read GitHub Projects v2 board. This migration does not select or configure Projects; membership, Status, Priority, milestone/dependency mappings and migrated ORC issues are **NOT VERIFIED**. Legacy Linear references remain provenance, not a second current task queue.
- **Development agent roles:** `chief` or `worker` (exactly one), optional `human` with `chief`, optional `metadata-bootstrap` only with `worker`. The owner manually invokes/schedules each development Chief/Worker agent; GitHub labels, Project transitions and Actions must **not** trigger models. Do not confuse the product's own runtime workers/leases with the governance role labels.
- **First handoff:** Chief selects approved Project and metadata, writes `GITHUB METADATA SETUP`, and ensures independent read-back. If Projects API is inaccessible, a `worker + metadata-bootstrap` task may perform **metadata only** and return to Chief; no product implementation until separate Chief DoR and Project `Ready`.
- **Full source-of-truth:** `docs/GITHUB_AGENT_GOVERNANCE.md` (latest approved template); for development workflow only, it supersedes old Linear instructions below. Product-specific safety/architecture/testing requirements remain binding.
- **Branch:** `master`. No product code, credentials, Project fields or deployment settings are edited in this PR.

---

## Preserved original Orchestrator instructions

# Orchestrator agent guide

## Source of truth

- This is a single-root Windows-first Electron + TypeScript app; `src/main` owns privileged work, `src/preload` exposes the narrow typed API, and `src/renderer` is sandboxed UI code.
- Read `README.md`, `MVP_plan.md`, and `docs/ARCHITECTURE.md` before changing lifecycle, persistence, policy, IPC, harness, recovery, or acceptance behavior. `MVP_plan.md` is the requirements baseline; do not rewrite it to record implementation progress.
- `COMMERCIAL_READINESS.md` is the evidence matrix. Do not turn source inspection, a commit, or a passing unit test into a release gate pass without the required runtime evidence.

## Commands and runtime requirements

- Install with `npm install`, build with `npm run build`, launch with `npm start`, and package an unsigned Windows x64 app with `npm run package:win` (output: `out/`).
- Use `npm test` as the canonical test command. It builds the native helper, compiles tests to `dist-test`, and runs the Electron-targeted suites; do not run compiled SQLite tests directly with ordinary Node.js.
- For one focused Electron suite, run `npm run build:native-helper`, `npx tsc -p tsconfig.test.json`, then `node scripts/run-electron-tests.mjs --expected=<count> dist-test/tests/<name>.test.js`; expected counts are recorded in the `test` script in `package.json`.
- Native runtime checks require Windows x64, Node.js 24.x, npm 12.x, Electron 44.x, `better-sqlite3` built for Electron ABI 149, Visual Studio C++ Build Tools, and a compatible Windows SDK.
- The live smoke runner is experiment-only: build first, configure `ORCHESTRATOR_OPENAI_BASE_URL`, `FREELLMAPI_API_KEY`, and `ORCHESTRATOR_OPENAI_MODEL`, then run `node experiments/runners/run-freellmapi-smoke.mjs --output <new-json> --source-revision <commit>`. Never write credentials into evidence.
- Backend SDK code is under `src/sdk`; verify it with `npx tsc -p tsconfig.test.json` and `node scripts/run-electron-tests.mjs --expected=2 dist-test/tests/sdk.test.js` because SQLite must load under Electron's ABI.

## Architecture and safety boundaries

- SQLite is authoritative for structured task/run/attempt/policy/dispatch/evidence/recovery state. Filesystem and Git contain source and artifacts but are not security boundaries; schema changes must use versioned migrations.
- Keep context isolation, renderer sandboxing, disabled renderer Node integration, restrictive CSP, trusted-sender/frame checks, and payload validation intact. Do not add remote access, multi-tenancy, or public-service behavior.
- The orchestrator owns policy, approvals, routing, deadlines, cancellation, recovery, review, and acceptance. Worker/adapter claims are inputs only; missing, stale, ambiguous, or incomplete evidence fails closed.
- Unknown or disconnected work becomes `recovery_required` and is not automatically replayed. A worker success stops at verification unless independent orchestrator evidence supports acceptance.
- v0.1 uses one active run/worker by default. Do not silently substitute providers/models/routes, enable delegated workers, auto-merge, force-push, or bypass protected/base branches.
- The deterministic fixture path is the UI-exercised route and supports risk-tier 1 only. The freellmapi/OpenAI-compatible adapter remains experiment/qualification-only until its mandatory capabilities, cancellation, restart reconciliation, provenance, and review gates are evidenced.
- `OrchestratorSdk.streamTask()` is the direct freellmapi planning/streaming path; workers receive leases and `orchestrator-worker-v1` handoffs and report through ordered, idempotent messages. Do not add a second LLM client in workers or integrations.
- Skills, MCP server profiles, and plugins are registry records selected by task IDs. Only selected skill instructions belong in an LLM prompt; MCP installation alone does not authorize tool execution.
- MCP calls and plugin execution must remain lease-owned, sequence-checked, auditable worker operations. Plugin entrypoints are trusted local code and must not be treated as an isolation boundary.

## Generated files and experiment evidence

- Do not hand-edit `dist/`, `dist-test/`, `dist-native/`, `out/`, or `*.tsbuildinfo`; they are generated and ignored.
- Preserve existing raw experiment records. Create a new output path for each trial and retain its source revision; use `experiments/runners/summarize-results.mjs` only to generate derived summaries.
- Never commit `.env*`, database files, credentials, runtime artifacts, `node_modules/`, or unrelated generated files. Check `git status` and review the exact diff before staging.

## Linear development tracking — all agents

- Use the existing [Agent Orchestrator project (P-ORC-1)](https://linear.app/agtorchestrator/project/agent-orchestrator-80206ec415c7) for development scope, decisions, blockers, and verified progress. SQLite remains authoritative for application runtime state; Git holds source and versioned evidence.
- Before work, read the relevant issue, the project START HERE handbook, and [agent tracking instructions](https://linear.app/agtorchestrator/document/agent-development-tracking-instructions-1-november-2026-cdd1f01d8728). Search before creating a duplicate issue. Map SDK work to ORC-19 and its workstreams ORC-20 through ORC-26.
- Use connected Linear tools when available. If shared agent-notes tools are unavailable, read project documents/issues directly. If access is blocked, report the blocker and pending updates; never claim synchronization succeeded.
- Record scope, acceptance conditions, branch/revision, and existing changes before implementation. Update the issue when work starts, scope changes, findings emerge, or verification completes. A review-only request does not authorize fixes.
- Track verified defects as focused linked issues with file/line, reproduction, impact, and regression criteria. Preserve decision provenance and distinguish proposed from approved decisions.
- Before handoff, record commands, exit results/test counts, evidence paths, remaining gaps, and uncommitted status; read back Linear changes. Mark Done only when acceptance conditions are met. Fixture tests do not prove live-provider, abrupt-crash, independent-review, or release qualification.
- Keep credentials and sensitive payloads out of Linear. Link the active issues, relevant decisions, source revision/branch, evidence, and blockers so another agent can resume without chat history.

## Linear executor labels and issue lifecycle — all agents

- Every actionable issue in the AgentConductor project must have exactly one label from the project's single-select `Agent Executor` group: `ChatGPT`, `Codex`, or `Work`. Use the existing `RBRN / Executor` group for Daemon Reborn issues. Do not apply one project's role-label group to another project.
- Choose `ChatGPT` for research, feasibility, architecture decisions, governance, and decision-ready reviews; `Codex` for bounded repository implementation, tests, and documentation; and `Work` for broad multi-step work, cross-application changes, Windows UI/manual validation, packaging, or end-to-end qualification. If the owner or role is unclear, ask before creating or dispatching the issue.
- Any agent creating an issue must search for duplicates, select the correct team and project, write the outcome, scope, acceptance criteria, required proof, and dependencies, set the appropriate parent/related links and priority, and apply exactly one executor label before saving. Never create an actionable issue with an unspecified executor.
- Before implementation, fetch the full issue and its comments, parent and child issues, blocking/blocked-by relations, and linked project handbooks, decisions, and specifications. Confirm prerequisites are complete; otherwise record the blocker in Linear and do not begin dependent work.
- Move the issue to the active status when work starts. Keep Linear current as scope, findings, dependencies, and blockers change. Before handoff, attach or link reproducible evidence: commands and exit results, test counts, artifact paths, and the relevant branch, commit, or pull request. Read back the saved issue and its evidence links. Mark Done only after acceptance criteria are supported by that proof; use a blocked status when a prerequisite prevents completion.

