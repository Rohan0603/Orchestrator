import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { HarnessAdapter, CapabilityManifest, Correlation, RouteIdentity, RouteRequirements, TerminalOutcome } from "../harness/adapter-contract";
import type { PolicyAction, PolicyDecisionRecord } from "../policy/policy";
import { evaluatePolicy } from "../policy/policy";
import {
  evaluateDispatchEligibility,
  createDispatchRecord,
  validateProgressEvent,
  type DispatchIntent
} from "../dispatch/dispatch-contract";
import type { AcceptanceRecord, Approval, Run, Task } from "../shared/domain";
import type { WorkspaceTarget } from "../workspace/workspace-contract";
import { DispatchRepository } from "../persistence/dispatch-repository";
import { PolicyRepository } from "../persistence/policy-repository";
import { RunRepository } from "../persistence/run-repository";
import { AcceptanceRepository } from "../persistence/acceptance-repository";
import { evaluateAcceptance } from "../acceptance/acceptance";

export interface LocalExecutionInput {
  readonly task: Task;
  readonly action: PolicyAction;
  readonly approval: Approval | null;
  readonly workspace: WorkspaceTarget;
  readonly manifest: CapabilityManifest;
  readonly route: RouteIdentity;
  readonly routeRequirements: RouteRequirements;
  readonly deadlineAt: string;
  readonly adapter: HarnessAdapter;
  readonly failureInjection?:
    | "after_intent"
    | "after_launch"
    | "before_terminal_persist"
    | "crash_after_intent"
    | "crash_after_launch"
    | "crash_before_terminal_persist";
}

export interface LocalExecutionResult {
  readonly run: Run;
  readonly attemptId: string;
  readonly policy: PolicyDecisionRecord;
  readonly status: "blocked" | "rejected" | "verification" | "recovery_required";
  readonly accepted: false;
  readonly progressAccepted: number;
  readonly progressRejected: number;
  readonly acceptance: AcceptanceRecord | null;
}

export async function executeLocalRun(
  database: Database.Database,
  input: LocalExecutionInput
): Promise<LocalExecutionResult> {
  const runs = new RunRepository(database);
  const dispatch = new DispatchRepository(database);
  const acceptance = new AcceptanceRepository(database);
  const policies = new PolicyRepository(database);
  const created = runs.createRun(input.task.id, input.route.routeId);
  const policy = evaluatePolicy(input.action);
  policies.recordDecision(policy);
  if (policy.decision !== "allowed" && policy.decision !== "approval_required") {
    runs.transition(created.run.id, "blocked", "none");
    return result(created.run, created.attempt.id, policy, "blocked", 0, 0);
  }

  runs.transition(created.run.id, "ready", "none");
  const readyRun = { ...created.run, state: "ready" as const };
  const eligibility = evaluateDispatchEligibility({
    task: input.task,
    run: readyRun,
    attempt: created.attempt,
    policy,
    action: input.action,
    approval: input.approval,
    workspace: input.workspace,
    manifest: input.manifest,
    route: input.route,
    routeRequirements: input.routeRequirements,
    deadlineAt: input.deadlineAt,
    existingIntent: null,
    repairCycles: 0
  });
  if (!eligibility.eligible) {
    runs.transition(created.run.id, "blocked", "none");
    return result(created.run, created.attempt.id, policy, "blocked", 0, 0);
  }
  if (policy.decision === "approval_required") {
    if (!input.approval) {
      runs.transition(created.run.id, "blocked", "none");
      return result(created.run, created.attempt.id, policy, "blocked", 0, 0);
    }
    policies.consumeApproval(input.approval.id, input.action, policy.policyVersion);
  }

  const correlation: Correlation = {
    dispatchId: randomUUID(),
    runId: created.run.id,
    attemptId: created.attempt.id
  };
  const intent: DispatchIntent = {
    id: randomUUID(),
    dispatchId: correlation.dispatchId,
    idempotencyKey: randomUUID(),
    correlation,
    taskId: input.task.id,
    runId: created.run.id,
    attemptId: created.attempt.id,
    route: input.route,
    authorization: {
      runId: created.run.id,
      attemptId: created.attempt.id,
      actionDigest: policy.actionDigest,
      approvalId: input.approval?.id ?? null,
      policyVersion: policy.policyVersion
    },
    deadlineAt: input.deadlineAt,
    state: "persisted",
    createdAt: new Date().toISOString()
  };
  dispatch.persistIntent(createDispatchRecord(intent, input.task, intent.authorization));
  if (input.failureInjection === "crash_after_intent") {
    runs.transition(created.run.id, "running", "none");
    throw new Error("Injected crash after durable dispatch intent");
  }
  if (input.failureInjection === "after_intent") {
    runs.recordAttemptOutcome(
      created.attempt.id,
      "inconclusive",
      "recovery_required",
      "recovery_required",
      "Injected failure after durable dispatch intent"
    );
    return result(created.run, created.attempt.id, policy, "recovery_required", 0, 0);
  }
  runs.transition(created.run.id, "running", "none");
  const dispatched = await input.adapter.createRun({
    dispatchId: intent.dispatchId,
    idempotencyKey: intent.idempotencyKey,
    authorization: intent.authorization,
    taskDescription: [
      input.task.description,
      "Acceptance criteria:",
      ...input.task.acceptanceCriteria.map((criterion) => `- ${criterion}`)
    ].join("\n"),
    deadlineAt: input.deadlineAt,
    route: input.route,
    workingDirectory: input.workspace.worktreePath ?? input.workspace.repositoryPath
  });
  if (!dispatched.ok) {
    const recovery = dispatched.error.class === "ambiguous";
    runs.recordAttemptOutcome(
      created.attempt.id,
      recovery ? "inconclusive" : "failed",
      recovery ? "recovery_required" : "rejected",
      recovery ? "recovery_required" : "none",
      dispatched.error.message
    );
    return result(
      created.run,
      created.attempt.id,
      policy,
      recovery ? "recovery_required" : "rejected",
      0,
      0
    );
  }
  if (input.failureInjection === "crash_after_launch") {
    throw new Error("Injected crash after launch acknowledgement");
  }
  if (input.failureInjection === "after_launch") {
    runs.recordAttemptOutcome(
      created.attempt.id,
      "inconclusive",
      "recovery_required",
      "recovery_required",
      "Injected failure after fixture launch acknowledgement"
    );
    return result(created.run, created.attempt.id, policy, "recovery_required", 0, 0);
  }

  let cursor = dispatch.createCursor(correlation);
  let progressAccepted = 0;
  let progressRejected = 0;
  const unsubscribeProgress = input.adapter.subscribeProgress(correlation, (event) => {
    const validation = validateProgressEvent(event, cursor);
    if (validation.disposition === "accepted") {
      dispatch.recordProgress(event, validation);
      progressAccepted += 1;
      cursor = validation.cursor;
    } else {
      progressRejected += 1;
    }
  });
  let terminal: TerminalOutcome | undefined;
  let resolveTerminal: ((outcome: TerminalOutcome) => void) | undefined;
  const terminalReady = new Promise<TerminalOutcome>((resolve) => {
    resolveTerminal = resolve;
  });
  const unsubscribeTerminal = input.adapter.subscribeTerminal(correlation, (outcome) => {
    terminal = outcome;
    resolveTerminal?.(outcome);
  });
  if (!terminal) {
    const remainingMs = Math.max(0, Date.parse(input.deadlineAt) - Date.now());
    terminal = await Promise.race([
      terminalReady,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), remainingMs))
    ]);
  }
  unsubscribeProgress();
  unsubscribeTerminal();
  if (!terminal) {
    runs.recordAttemptOutcome(
      created.attempt.id,
      "inconclusive",
      "recovery_required",
      "recovery_required",
      "Fixture ended without terminal outcome"
    );
    return result(created.run, created.attempt.id, policy, "recovery_required", progressAccepted, progressRejected);
  }
  const status = terminal.kind === "succeeded"
    ? "verification"
    : terminal.kind === "failed"
      ? "rejected"
      : terminal.kind === "disconnected" || terminal.kind === "inconclusive"
        ? "recovery_required"
        : "verification";
  const outcome = terminal.kind === "succeeded" ? "succeeded" : terminal.kind === "failed" ? "failed" : terminal.kind === "cancelled" ? "cancelled" : terminal.kind === "timed_out" ? "timed_out" : "inconclusive";
  if (input.failureInjection === "before_terminal_persist") {
    runs.recordAttemptOutcome(
      created.attempt.id,
      "inconclusive",
      "recovery_required",
      "recovery_required",
      "Injected failure before terminal persistence"
    );
    return result(created.run, created.attempt.id, policy, "recovery_required", progressAccepted, progressRejected);
  }
  if (input.failureInjection === "crash_before_terminal_persist") {
    throw new Error("Injected crash before terminal persistence");
  }
  runs.recordAttemptOutcome(
    created.attempt.id,
    outcome,
    status,
    status === "recovery_required" ? "recovery_required" : "none",
    terminal.error?.message ?? terminal.kind
  );
  let acceptanceDecision: AcceptanceRecord | null = null;
  if (terminal.kind === "succeeded") {
    acceptanceDecision = evaluateAcceptance({
      criteriaVerified: true,
      deterministicChecksPassed: true,
      evidenceComplete: false,
      independentReview: "blocked"
    });
    acceptance.record(
      created.run.id,
      acceptanceDecision
    );
  }
  return result(
    created.run,
    created.attempt.id,
    policy,
    status,
    progressAccepted,
    progressRejected,
    acceptanceDecision
  );
}

function result(
  run: Run,
  attemptId: string,
  policy: PolicyDecisionRecord,
  status: LocalExecutionResult["status"],
  progressAccepted: number,
  progressRejected: number,
  acceptance: AcceptanceRecord | null = null
): LocalExecutionResult {
  return {
    run,
    attemptId,
    policy,
    status,
    accepted: false,
    progressAccepted,
    progressRejected,
    acceptance
  };
}
