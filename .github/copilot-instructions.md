# Orchestrator project instructions

## Project and architecture

- Orchestrator is a Windows-first, local, single-user Electron + TypeScript application.
- SQLite is authoritative for structured task, run, attempt, approval, outbox, audit, and recovery state.
- Filesystem and Git hold source, diffs, and artifacts. A run-owned worktree is operational isolation, not a security boundary.
- Keep operation loopback-only. Do not add remote access, multi-tenancy, or public service behavior.
- Default to one active run and one worker. Delegated multi-worker execution and external agents remain disabled in v0.1.
- OpenCode is an initial harness candidate, not a qualified integration.
- Maintain a project-owned, versioned harness adapter contract and capability manifest.
- The orchestrator owns policy, approvals, lifecycle, dispatch, deadlines, retries, recovery, audit, review, and acceptance. Workers execute and report; workers are not acceptance authorities.

## Security and evidence

- Electron main owns privileged operations. Keep renderer sandboxing and context isolation enabled.
- Use restrictive CSP, no renderer Node integration, and a narrow typed preload API.
- Validate IPC sender identity and payload shape at the boundary.
- Fail closed when mandatory capabilities, required checks, review, or evidence are missing, stale, conflicting, or inconclusive.
- Reviewers evaluate independently and must not silently edit worker output.
- Preserve durable state and recovery-critical evidence.
- Never silently substitute a model, provider, route, or capability.
- Do not auto-merge, force-push, bypass protected or base branches, or treat a worktree as a security boundary.

## GPT-5.6 Luna model gate

- The user is responsible for manually selecting and confirming GPT-5.6 Luna for the current lead agent.
- The user's explicit statement that GPT-5.6 Luna is selected is sufficient confirmation under this policy. Do not repeatedly ask for confirmation.
- Follow the user-confirmed lead-agent selection. Do not require host diagnostics as a prerequisite when the user has confirmed selection.
- Distinguish user-confirmed selection from independently verified runtime identity. Do not claim independent runtime verification when authoritative host evidence is unavailable.
- If the user reports that GPT-5.6 Luna is unavailable or not selected, stop affected work and report it. Otherwise proceed with authorized work.
- Only the current lead agent may perform Orchestrator agentic work.
- Never spawn, launch, create, invoke, or delegate to subagents, child agents, secondary agents, parallel agents, or agent swarms.
- Never use a tool, SDK, API, CLI, orchestration framework, harness, provider, plugin, MCP server, or external service to start another AI agent.
- Do not create implementation-agent, reviewer-agent, planner-agent, or other child-agent definitions intended for delegation.
- If parallel work would help, decompose it into sequential bounded tasks in the current session.
- Perform planning, implementation, review, security review, authorized testing, and acceptance analysis in the current lead session.
- Distinguish requested model, configured model, and verified effective runtime model.
- Verify effective model with authoritative runtime evidence when available; otherwise record runtime identity as unverified without turning missing diagnostics into a repeated confirmation loop.
- Prompt text, an accepted model identifier, or configuration intent is not runtime evidence.
- Stop affected work when GPT-5.6 Luna is reported unavailable or not selected. Missing host verification alone does not block work after user confirmation.
- Never silently substitute another model or provider.
- Do not install extensions or change global, provider, or credential settings to bypass this gate without separate authorization.
- These instructions state policy; they cannot technically enforce model selection when the agent host does not support it.

## Development workflow

- Read `MVP_plan.md`, applicable project plans, and existing files before each task.
- Work in small, dependency-ordered tasks. Select only tasks whose prerequisites are satisfied.
- State task scope, allowed files, non-goals, dependencies, acceptance criteria, evidence, and stop conditions.
- Reuse existing patterns. Keep changes small, strongly typed, and explicit.
- Make routine reversible choices autonomously within the approved design.
- Escalate unresolved decisions affecting security, data integrity, authorization, model routing, provider behavior, or recovery.
- Update only an authorized execution plan or session notes with actual changes, decisions, evidence, and unresolved risks. Never overwrite or silently change `MVP_plan.md`, the approved requirements baseline.
- Report files changed, acceptance evidence, remaining work, and the next dependency-ready task.
- Never claim tests, builds, integrations, qualification, or runtime behavior were verified unless they actually ran under authorization.
- Conduct self-review with explicit checklists, acceptance criteria, deterministic checks, and recorded evidence when authorized. Label self-review as self-review, not independent review.
- Preserve approved independent-review requirements. If no separate reviewer can be used because single-agent execution is mandatory, mark that acceptance criterion unmet or blocked; do not waive or redefine it.

## Git CLI and stage checkpoints

- Use the Git CLI for repository initialization, inspection, staging, committing,
  branching, and other explicitly authorized Git operations. Do not use Git GUI
  workflows or delegate Git operations.
- Do not initialize a nested repository. Never discard, reset, clean, overwrite,
  or silently omit existing user changes.
- Inspect `git status` and review the intended diff before staging. Stage only
  reviewed files; never use `git add .` or `git add -A` as a substitute for
  reviewing the intended file set.
- Never bypass hooks or safety checks to make a commit succeed. Never commit
  secrets, credentials, private keys, tokens, personal data, local databases,
  runtime artifacts, dependency directories, or unrelated generated files.
- Keep `.gitignore` aligned with the architecture. Do not ignore source files
  or required project configuration.
- Every completed implementation stage gets one local commit after its
  authorized source-level acceptance review. Report stage, full commit hash,
  message, reviewed scope, and remaining uncommitted changes.
- A commit is a source-control checkpoint, not proof of builds, tests, security
  qualification, runtime correctness, or independent review.
- Do not amend, rebase, squash, reset, force-push, rewrite history, configure
  remotes, or push without separate explicit authorization. Never use commits
  to bypass protected-branch or approval policies.
- If unrelated changes exist, preserve them and commit only safely attributable
  stage files. If scope cannot be isolated, stop and report the blocker.

## Separate authorization gates

Treat each item below as separately gated. A general request to develop does not bypass these gates:

- Installing or updating dependencies, tools, or extensions.
- Changing global, provider, credential, or agent configuration.
- External provider integrations, network calls, or external side effects.
- Tests, builds, linters, scripts, benchmarks, and qualification.
- Adapter feasibility or conformance work.
- Cancellation, process termination, restart/recovery, and fault exercises.
- Backup/restore validation or operational reliability claims.
