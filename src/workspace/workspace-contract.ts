export interface WorkspaceTarget {
  readonly repositoryPath: string;
  readonly targetBranch: string;
  readonly baseBranch: string;
  readonly confirmedByUser: boolean;
  readonly worktreePath: string | null;
  readonly prohibitedOperation: boolean;
}

export type WorkspaceDecision = "ready" | "blocked" | "unsupported";

export interface WorkspaceCheck {
  readonly decision: WorkspaceDecision;
  readonly reasonCode:
    | "TARGET_CONFIRMED"
    | "TARGET_NOT_CONFIRMED"
    | "CAPABILITY_UNVERIFIED"
    | "PROTECTED_BRANCH"
    | "MUTATION_PROHIBITED";
  readonly reason: string;
}

export function evaluateWorkspaceTarget(target: WorkspaceTarget): WorkspaceCheck {
  if (
    !target.repositoryPath ||
    !target.targetBranch ||
    !target.baseBranch ||
    !target.confirmedByUser
  ) {
    return {
      decision: "blocked",
      reasonCode: "TARGET_NOT_CONFIRMED",
      reason: "Repository and target branch require explicit user confirmation"
    };
  }
  if (target.prohibitedOperation) {
    return {
      decision: "blocked",
      reasonCode: "MUTATION_PROHIBITED",
      reason: "Automatic merge, force-push, or protected-branch bypass is prohibited"
    };
  }
  if (
    target.targetBranch === target.baseBranch ||
    target.targetBranch.toLowerCase() === "main" ||
    target.targetBranch.toLowerCase() === "master"
  ) {
    return {
      decision: "blocked",
      reasonCode: "PROTECTED_BRANCH",
      reason: "Protected or base branch mutation is not permitted"
    };
  }
  if (!target.worktreePath) {
    return {
      decision: "unsupported",
      reasonCode: "CAPABILITY_UNVERIFIED",
      reason: "Run-owned worktree capability is not verified"
    };
  }
  return {
    decision: "ready",
    reasonCode: "TARGET_CONFIRMED",
    reason: "Workspace target is explicitly confirmed"
  };
}
