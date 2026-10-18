# Orchestrator --- v0.1 MVP Plan

**Document status:** Design and planning baseline\
**Project name:** Orchestrator\
**Suggested descriptor:** Local Agentic Development Orchestrator\
**Version:** 0.1 MVP\
**Last updated:** 2026-10-18\
**Implementation status:** Not started / not verified\
**Authorization status:** Design is finalized for planning;
implementation and validation activities require separate explicit
authorization.

------------------------------------------------------------------------

## 1. Project name

### Recommendation: Orchestrator

Keep **Orchestrator** as the project name. It directly describes the
product's core responsibility: coordinating coding tasks, workers,
policy, verification, review, recovery, and acceptance rather than being
another coding agent.

Use this descriptor in documentation and repositories when more context
is useful:

> **Orchestrator --- Local Agentic Development Orchestrator**

The name is clear and aligned with the existing project artifacts. It is
a working product name, not a claim of trademark or domain availability.

------------------------------------------------------------------------

## 2. Vision and objective

Build a Windows-first, local, single-user application that manages an
end-to-end agentic coding-task lifecycle with explicit policy
enforcement, durable state, independent review, bounded repair, and
auditable evidence.

The orchestrator---not the worker agent---owns task and run state,
dispatch, policy decisions, approvals, deadlines, retry/recovery
behavior, review, and final acceptance. Workers execute authorized work
and report structured progress and outcomes. Reviewers independently
evaluate results and do not silently modify worker output.

The MVP should establish a trustworthy vertical slice before expanding
into delegation, remote operation, advanced analytics, or broader
orchestration.

### MVP success principle

A task is not accepted merely because a worker says it succeeded.
Acceptance requires the configured criteria, required deterministic
checks, applicable independent review, no blocking findings, and durable
diff/evidence. Missing or inconclusive evidence is not a pass.

------------------------------------------------------------------------

## 3. Scope

### In scope

-   Windows-first Electron application with TypeScript.
-   Single local user and loopback-only operation.
-   Secure Electron process boundaries and narrow, typed IPC.
-   SQLite as the authoritative store for structured task, run, attempt,
    approval, outbox, and audit state.
-   Filesystem and Git for source and task artifacts.
-   Local Git repository workflow with user-confirmed target branch and
    run-owned worktree.
-   One active run and one worker by default; actual worker delegation
    remains disabled.
-   Task intake, planning, policy checks, approval gates, dispatch,
    structured progress, terminal outcomes, verification, independent
    review, bounded repair, and acceptance/rejection.
-   Versioned, project-owned Harness Adapter Contract and capability
    manifest.
-   OpenCode as the initial harness candidate, with interface options
    compared only to the extent their semantics can be established.
-   Durable state and restart reconciliation from the first usable
    build.
-   Cancellation and process ownership design, with unknown termination
    capability treated as unsupported/unverified rather than assumed
    safe.
-   Auditable decisions, provenance, diffs, and evidence.
-   Setup preflight that detects required tools/configuration but does
    not automatically install or configure them.
-   Explicit action-level policy, one-shot approvals, and default/YOLO
    modes as specified by approved decisions.
-   Documentation, fixtures, lifecycle invariants, acceptance criteria,
    and security/recovery review.

### Out of scope for v0.1

-   Remote access, public service, multi-tenancy, or distributed
    execution.
-   External agents/A2A or actual delegated multi-worker execution.
-   Mandatory MCP, third-party plugins, MAF/LangGraph runtime, or
    CodeRabbit dependency.
-   Auto-merge, force-push, or bypass of protected/base-branch
    restrictions.
-   Distributed brokers, vector databases, and advanced analytics.
-   Automatic installation or configuration of dependencies, providers,
    or tools.
-   Silent provider/model substitution or silent cross-provider
    fallback.
-   Treating a worktree as a security boundary.
-   Claims of backup/restore guarantees before separately authorized
    validation.
-   Claims that adapter qualification, tests, benchmarks, cancellation,
    recovery, or reviewer experiments have passed before they are
    authorized and run.

------------------------------------------------------------------------

## 4. Architecture baseline

### 4.1 Application shell and security

-   Electron main process owns privileged operations and application
    services.
-   Renderer is sandboxed and has no direct Node.js integration.
-   Context isolation is enabled.
-   Content Security Policy is restrictive.
-   A narrow, typed preload API exposes only required capabilities.
-   IPC validates sender identity and payload shape.
-   The application remains local and loopback-only; no remote-access
    surface is introduced in the MVP.

### 4.2 Domain and persistence

-   SQLite is authoritative for structured lifecycle and policy state.
-   Schema changes are versioned and migrated through explicit
    migrations.
-   Task, run, attempt, approval, outbox, and audit records have clear
    ownership and lifecycle semantics.
-   Filesystem/Git store source, diffs, and artifacts; references to
    those artifacts are durably recorded.
-   State transitions and invariants are explicit rather than inferred
    from UI state or worker messages.

### 4.3 Orchestration responsibilities

The orchestrator owns:

-   Task intake and plan representation.
-   Task/run/attempt identity and state.
-   Policy evaluation and approval decisions.
-   Dispatch and route selection.
-   Deadlines, retry budgets, and repair-cycle limits.
-   Cancellation requests and reconciliation.
-   Restart/disconnect recovery.
-   Audit and evidence provenance.
-   Verification, independent review, and acceptance.

Workers execute authorized work and provide structured progress and
terminal outcomes. Worker claims are evidence inputs, not acceptance
authority.

Reviewers independently evaluate the result against criteria and
evidence. They must not silently edit the worker's changes.

### 4.4 Harness integration

-   OpenCode is the initial harness candidate.
-   ACP, OpenCode server plus official TypeScript SDK/API, and CLI
    JSON/interface are comparison candidates only where required
    semantics can be established.
-   No empirical winner is declared before separately authorized
    feasibility/conformance work.
-   The adapter contract is project-owned and versioned.
-   Capability states are `supported`, `unsupported`, `conditional`, and
    `unverified`, with evidence/version/environment recorded.
-   Missing capability entries are `unverified`.
-   Any unverified mandatory capability blocks the route.
-   Optional fallback is allowed only when the task and policy permit
    it, the destination independently qualifies, and substitution is
    explicit.
-   No silent model/provider substitution or cross-provider fallback.

### 4.5 Git and workspace management

-   Operate on local Git repositories.
-   The user confirms the target branch.
-   A run-owned worktree isolates task changes operationally but is not
    treated as a security boundary.
-   No auto-merge, force-push, or protected/base-branch bypass.
-   Git operations remain subject to OS, host/provider, and explicit
    policy restrictions, including in YOLO mode.

------------------------------------------------------------------------

## 5. Lifecycle and acceptance

The intended end-to-end lifecycle is:

1.  **Intake** --- capture the task, repository context, constraints,
    and acceptance criteria.
2.  **Plan** --- create an explicit plan and identify risk tier,
    required capabilities, and verification obligations.
3.  **Policy evaluation** --- classify actions and determine which
    actions are permitted, blocked, or require approval.
4.  **Approval** --- obtain action-bound approval where required;
    material changes to approved action context require new approval.
5.  **Preparation** --- confirm repository and target branch, check
    prerequisites, and establish the run-owned workspace.
6.  **Dispatch** --- select only a route whose mandatory capabilities
    and policy requirements are satisfied.
7.  **Execution** --- receive structured progress, artifacts, and
    terminal outcomes from the worker.
8.  **Verification** --- perform required deterministic checks when
    separately authorized.
9.  **Independent review** --- evaluate the diff and evidence using the
    applicable review rubric.
10. **Repair** --- if permitted, execute a bounded repair cycle, then
    repeat review and regression verification.
11. **Acceptance decision** --- accept only when all required evidence
    and criteria pass; otherwise reject or mark blocked/inconclusive.
12. **Finalization** --- persist status, audit trail, diff/artifact
    references, and recovery-relevant state.
13. **Recovery** --- reconcile interrupted or uncertain runs after
    disconnect/restart; do not assume a worker stopped just because the
    UI or session disappeared.

### Repair budget

Default to the initial attempt plus at most two repair cycles. Each
repair must be followed by re-review and regression verification. A
third cycle is not the default; it requires evidence-based justification
and an approved design change.

### Review risk tiers

-   Three risk tiers are part of the design.
-   Tier 2 and Tier 3 require independent review.
-   Tier 3 requires stronger verification and non-waivable controls.
-   The detailed action classification and tier requirements must follow
    the approved decision artifacts; do not infer blanket permission
    from a mode label.

### Evidence rule

Missing, stale, conflicting, or inconclusive evidence cannot be treated
as a pass. Preserve the distinction between task outcome, attempt
outcome, provider route, and recovery state.

------------------------------------------------------------------------

## 6. Policy, approvals, and model routing

-   Use explicit action-level risk classification.
-   Default and YOLO modes follow the approved policy decisions.
-   YOLO does not override OS, provider, Git-host, or explicitly
    forbidden-operation restrictions.
-   Approval is one-shot and bound to the exact action context,
    including command/action, executable, arguments, target, and payload
    as applicable.
-   The proposed default approval expiry is 15 minutes; implement only
    as specified by the authoritative decisions.
-   Material changes to an approved action require a new confirmation.
-   Provider/model identity and fidelity must be explicit.
-   Do not silently substitute providers or models.
-   If a mandatory capability cannot be verified, block that route.
-   Explicit task deadlines remain strict across provider waits and
    restarts unless an audited, authorized extension applies.
-   There is no hard per-run token cap, monetary ceiling, or general
    wall-clock run-stop limit in the approved design baseline.

------------------------------------------------------------------------

## 7. Cancellation, restart, recovery, audit, and storage

### Cancellation and process ownership

The approved design baseline specifies a 30-second graceful cancellation
period, followed by a termination signal, then a forceful termination
after another 5 seconds only for a verified run-owned process group/job.
Platform-specific process ownership must be implemented and assessed
against the approved design. Unknown termination capability is
unsupported/unverified.

If termination cannot be verified, mark the run `recovery_required` and
stop new dispatch for that run. Do not claim cancellation succeeded
merely because a request was sent.

### Restart and disconnect recovery

-   Durable state and restart reconciliation are required from the first
    usable build.
-   Reconcile persisted lifecycle state with observable process/session
    state.
-   Treat uncertainty as uncertainty; do not silently mark interrupted
    work complete or stopped.
-   Preserve evidence and prevent unsafe redispatch when prior execution
    may still be active.
-   Recovery validation is a separate authorization gate.

### Audit and evidence

-   Use hash-linked audit events for tamper evidence; do not describe
    the chain as tamper-proof.
-   The design baseline proposes 30-day structured audit retention and
    7-day verbose evidence retention, while preserving active,
    recovery-critical, open-workflow, and pinned artifacts.
-   The proposed backup retention is 7 daily and 4 weekly copies.
-   These are design defaults, not validated retention guarantees.

### Storage safety

-   The proposed disk warning threshold is below 15%.
-   Pause below 5%, or earlier when writes become unsafe or recovery is
    uncertain.
-   Critical storage/audit persistence failure stops new runs and side
    effects.
-   Preserve critical evidence; do not automatically delete
    recovery-critical artifacts.
-   Backup/restore guarantees must not be claimed until separately
    authorized validation is complete.

------------------------------------------------------------------------

## 8. Ordered delivery roadmap

This is a proposed implementation sequence, not authorization to execute
it.

### Stage 0 --- Read-only repository reconnaissance

**Purpose:** Establish the actual repository baseline and map the
approved design to existing files and modules.

Deliverables: - Repository and Git baseline. - Module and architecture
inventory. - Requirement-to-code traceability matrix. - Gap/discrepancy
register. - Ordered backlog with acceptance criteria. - Proposed first
vertical slice. - Security, lifecycle, cancellation, and recovery risk
register. - Model-selection and subagent-enforcement findings.

Restrictions: - No edits, installs, configuration changes, builds,
tests, benchmarks, qualification, worktrees, or external side effects. -
Stop after the report and await explicit authorization.

### Stage 1 --- Foundation

Subject to separate implementation authorization: - Establish the
Electron/TypeScript application shell and secure process boundaries. -
Define domain types, lifecycle states, and invariants. - Establish
SQLite persistence and versioned migrations. - Add audit/outbox
persistence and failure handling. - Add typed IPC and input/sender
validation. - Add baseline application status and error reporting.

Exit criteria: - Architecture matches the approved specification. -
Security boundaries are reviewable. - Durable lifecycle records and
invariants are represented. - No claim of runtime correctness until
separately authorized verification occurs.

### Stage 2 --- End-to-end vertical slice

Subject to separate implementation authorization and required adapter
capability decisions: - Task intake and acceptance criteria. - Policy
evaluation and action-bound approval. - Repository/target-branch
confirmation and run-owned worktree boundary. - Harness adapter boundary
and capability-manifest enforcement. - Structured worker progress and
terminal outcomes. - Diff and artifact provenance. - Required
verification and independent review. - Bounded repair and re-review. -
Explicit accepted, rejected, blocked, and inconclusive outcomes.

Exit criteria: - Each transition has explicit ownership and durable
state. - Missing mandatory capabilities block dispatch. - Acceptance
cannot bypass required evidence or review.

### Stage 3 --- Safety and recovery implementation

Subject to separate implementation authorization: - Cancellation and
process ownership. - Disconnect/restart reconciliation. - Deadline and
retry behavior. - Cleanup and artifact retention. - Audit/storage
failure handling. - Recovery-required state and dispatch blocking. -
Security and recovery threat review.

Implementation does not equal validation. Exercise and qualification of
these behaviors remain separately gated.

### Stage 4 --- Separately authorized validation and pilot readiness

No activity in this stage is authorized by this plan alone.

Potential separately authorized work: - Adapter feasibility and
conformance. - Deterministic tests and lifecycle invariant tests. -
Reviewer gold-set evaluation. - Repair-cycle comparison. - Offline
routing evaluation while delegation remains disabled. - Cancellation,
restart, recovery, and process-ownership fault exercises. -
Backup/restore validation. - Pilot readiness review.

The approved protocol thresholds are provisional defaults, not measured
results. Nondeterministic tasks begin with three independent trials;
expand to five to ten or more when variability, risk, or borderline
outcomes warrant it. Deterministic fault scenarios have a proposed
minimum of five repetitions per scenario. These thresholds do not prove
reliability and must be interpreted with sample-size limitations.

------------------------------------------------------------------------

## 9. Validation gates and provisional protocol thresholds

These values are protocol defaults, not evidence of achieved
performance.

  -----------------------------------------------------------------------
  Area                                Provisional gate
  ----------------------------------- -----------------------------------
  Mandatory adapter capabilities      100% of applicable mandatory
                                      capabilities pass; zero silent
                                      degradation

  Cancellation/recovery fault         Zero observed hard-gate violations;
  scenarios                           initial floor of at least five
                                      repetitions per deterministic
                                      scenario

  Independent review                  Zero observed Critical misses in
                                      the frozen evaluation set; also
                                      report false positives,
                                      recall/precision, escaped blockers,
                                      and incremental cost

  Repair policy                       Retain the two-cycle maximum unless
                                      a simpler limit has comparable
                                      acceptance at lower cost; consider
                                      a third cycle only if acceptance
                                      improves by at least 5 percentage
                                      points without blocking regression

  Routing                             Zero mandatory capability/policy
                                      violations and 100% correct
                                      handling of explicitly forbidden
                                      routes

  Nondeterministic tasks              Three independent trials initially;
                                      expand to 5--10+ when variability
                                      or decision risk warrants it
  -----------------------------------------------------------------------

No experiments have run as part of this plan. Results must be reported
as not measured until obtained under separate authorization.

------------------------------------------------------------------------

## 10. VS Code agent workflow

### Global model rule

**GPT-5.6 Luna only for every development agent and subagent.**

-   Verify the effective model when the environment exposes it.
-   Do not silently fall back to another model/provider.
-   If model selection cannot be verified or the required model is
    unavailable, stop the affected task and report the limitation.
-   A prompt alone does not technically guarantee model selection; use
    only configuration controls already available and authorized.
-   Do not install extensions or change provider/global settings without
    separate authorization.

### Recommended roles

-   **Lead/orchestrator agent:** Owns the plan, task boundaries,
    dependency ordering, and consolidated report.
-   **Implementation agent:** Implements only explicitly authorized,
    bounded backlog items.
-   **Independent verification/review agent:** Evaluates changes and
    evidence without silently editing the implementation.
-   **Security and recovery reviewer:** Reviews privilege boundaries,
    policy enforcement, cancellation, process ownership, durable state,
    and recovery behavior.

Start with one lead agent for reconnaissance. Add parallel agents only
when tasks are genuinely independent, model selection is compliant, and
the work is authorized. Delegation never expands authorization.

### Task execution discipline

Every future implementation task should include: - Exact scope and
non-goals. - Files/modules allowed to change. - Dependencies and
preconditions. - Acceptance criteria. - Required verification and
evidence. - Prohibited actions. - Stop conditions and escalation rules.

The lead agent must inspect the diff and evidence before assigning the
next dependent task. Do not let agents self-authorize additional scope.

------------------------------------------------------------------------

## 11. Explicit authorization boundary

This document is a plan. It does not authorize implementation or
validation.

Separate explicit authorization is required before: - Coding or
modifying repository files. - Installing or updating dependencies,
tools, or extensions. - Changing application, provider, agent, or VS
Code configuration. - Integrating a harness or provider. - Running
tests, builds, scripts, benchmarks, or qualification. - Performing
adapter conformance or experimental comparisons. - Exercising
cancellation, restart, recovery, process termination, or fault
scenarios. - Validating backup/restore or asserting operational
guarantees. - Making external service calls or other side-effecting
changes.

Read-only reconnaissance may proceed under its separately defined
authorization. After Stage 0, stop and obtain human review before
implementation.

------------------------------------------------------------------------

## 12. Immediate next action

1.  Open the Orchestrator repository in VS Code.
2.  Run the read-only Stage 0 reconnaissance prompt with the lead agent.
3.  Review the returned evidence, traceability matrix, risks, and
    backlog.
4.  Reconcile repository findings with the approved design artifacts.
5.  Obtain explicit authorization before beginning any implementation
    task.
6.  Obtain separate authorization for each validation/qualification
    category that remains gated.

### Stage 0 completion statement

> Stage 0 reconnaissance complete. No implementation or validation was
> performed. Awaiting explicit authorization before any code,
> configuration, installation, integration, test, benchmark,
> qualification, cancellation, recovery, or backup/restore activity.

------------------------------------------------------------------------

## 14. Mandatory engineering rule — reuse before inventing

**Status:** Mandatory engineering principle for all future Orchestrator implementation and research work. This rule governs how implementation options are evaluated; it does not itself authorize dependency installation or architecture migration.

### 14.1 Absolute rule

Before implementing any general-purpose capability, the agent MUST:

1. Inspect the current repository, installed dependencies, existing utilities, tests and prior decisions.
2. Research suitable official APIs, maintained libraries, reusable components, open-source templates and established standards.
3. Compare the best existing option with the simplest alternative against functional fit, accessibility, security, license, maintenance, dependency/transitive dependency impact, runtime/build compatibility, Windows/Electron compatibility and testability.
4. Reuse an existing solution by default when it meets the requirements.
5. Document why available options are unsuitable before choosing custom code. “I can write it quickly,” personal preference, or failure to inspect documentation are not sufficient reasons.
6. Prefer a small reusable component or existing platform API over importing a large framework for one small feature.
7. Verify license and provenance from authoritative sources. A public repository without a clear license is not automatically reusable.
8. Review installation scripts, permissions, network behavior, package health, dependency tree and Electron security posture before adoption.
9. Add meaningful tests and verify build/package behavior relevant to the change.
10. Never silently replace the approved framework, build system, persistence model, process-control design or security boundary. Material architectural changes require explicit comparison and applicable authorization.
11. Report research limitations, compatibility unknowns and unverified claims honestly.

This gate applies to UI/UX, icons, design systems, forms, dialogs, tables, charts, routing, state management, accessibility, testing, logging, persistence, adapters, process control, Git operations, packaging, diagnostics, telemetry and documentation tooling.

### 14.2 Research findings for the current UI

The current renderer is vanilla TypeScript, HTML and CSS. A React-oriented component library cannot be dropped in without a framework/build integration decision. Preserve the secure Electron main/preload boundary regardless of the renderer technology.

| Capability | Candidate | Recommendation |
|---|---|---|
| Reusable component system | [shadcn/ui](https://ui.shadcn.com/docs/components) | Preferred candidate if a React modernization is approved; component source is customizable and theme tokens use CSS variables. |
| Accessible UI primitives | [Radix Primitives](https://www.radix-ui.com/primitives) | Candidate to pair with shadcn/ui. |
| Alternative accessible components | [React Aria Components](https://react-aria.adobe.com/) | Alternative to Radix, not a second overlapping primitive stack. |
| Consistent icons | [Lucide](https://lucide.dev/) | Good candidate; ISC license. Use a small, consistent icon set. |
| Electron + React reference template | [electron-vite-react](https://github.com/electron-vite/electron-vite-react) | MIT-licensed reference template with public project history. Do not copy its renderer privilege posture; the project must retain sandboxing and a narrow preload bridge. |
| Electron + shadcn reference template | [electron-react-shadcn-template](https://github.com/ZilvinasAbr/electron-react-shadcn-template) | Useful integration example, but independently review its current code, license, dependencies and security before reusing anything. |
| Data tables | [TanStack Table](https://tanstack.com/table/latest/docs/overview) | Consider only if task/run/audit lists need sorting, filtering or pagination beyond simple native tables. |
| Ready-made data grid | [AG Grid Community](https://www.ag-grid.com/react-data-grid/) | Consider only when requirements justify a full grid; verify Community versus Enterprise licensing and features. |
| Workflow diagrams | [React Flow](https://reactflow.dev/) | MIT-licensed option for a future interactive graph; unnecessary for a simple status timeline. |
| Accessibility testing | [Playwright accessibility guidance](https://playwright.dev/docs/accessibility-testing) | Consider compatible automated accessibility checks alongside keyboard and manual testing. |
| Electron build templates | [Electron Forge](https://www.electronforge.io/) | Official templates are useful references; assess migration cost and the current maturity of build plugins before changing the existing build. |

### 14.3 UI/UX adoption strategy

Do not expand the current single-page form into a bespoke UI framework. First establish a small, consistent design system and reusable interaction patterns:

- Clear task/run workspace and navigation.
- Reusable field, validation, error, loading and empty-state patterns.
- Consistent status badges for running, verifying, reviewing, blocked, recovery-required and accepted.
- Run details with attempts, verification, review and evidence.
- Honest approval and blocked-state explanations.
- Consistent iconography and spacing/typography/color tokens.
- Keyboard navigation, visible focus, semantic labels and adequate contrast.
- Clear visual separation between deterministic fixture execution and real-worker execution.

Every displayed status must reflect backend state. UI polish must not hide uncertainty or make an unqualified route appear operational.

### 14.4 Decision and authorization boundary

**Adopt now as policy:** reuse-before-invent research, license/provenance review, compatibility/security review and accessibility considerations.

**Preferred future UI candidate:** evaluate React + TypeScript + shadcn/ui, one primitive family (Radix OR React Aria), and Lucide icons if UI modernization is authorized.

**Not approved by this research:** installing packages, migrating the renderer, replacing the build system, adopting a full template, or changing the security architecture.

No package was installed and no runtime compatibility was demonstrated by this research. Before selecting a stack, inspect the actual local repository, dependency tree, build pipeline, Electron security settings and test coverage; compare incremental enhancement against a controlled migration.

### 14.5 Research sources

- shadcn/ui components and theming: https://ui.shadcn.com/docs/components and https://ui.shadcn.com/docs/theming
- Radix Primitives: https://www.radix-ui.com/primitives
- React Aria: https://react-aria.adobe.com/
- Lucide and license: https://lucide.dev/ and https://lucide.dev/license
- Electron + Vite + React template: https://github.com/electron-vite/electron-vite-react
- Electron + shadcn template: https://github.com/ZilvinasAbr/electron-react-shadcn-template
- Electron Forge: https://www.electronforge.io/
- TanStack Table: https://tanstack.com/table/latest/docs/overview
- AG Grid: https://www.ag-grid.com/react-data-grid/
- React Flow: https://reactflow.dev/
- Playwright accessibility testing: https://playwright.dev/docs/accessibility-testing
