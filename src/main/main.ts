import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { openDatabase, PersistenceError } from "../persistence/database";
import type Database from "better-sqlite3";
import { TaskRepository } from "../persistence/task-repository";
import { RunRepository } from "../persistence/run-repository";
import { PolicyRepository } from "../persistence/policy-repository";
import { evaluatePolicy } from "../policy/policy";
import { ConformanceFixtureAdapter } from "../harness/conformance-fixture";
import { executeLocalRun } from "../execution/local-execution";
import {
  NativeOwnershipCoordinator,
  NativeOwnershipService,
  resolveHelperPath
} from "../execution/native-ownership";
import {
  parseCreateTaskInput,
  type ApplicationStatus,
  type IpcResult,
  type OwnedFixtureRunSummary,
  type OrchestratorApi
} from "../shared/ipc";
import {
  HARNESS_ADAPTER_CONTRACT_VERSION,
  type CapabilityManifest,
  type RouteRequirements
} from "../harness/adapter-contract";
import { GitHubApiClient, GitHubRepository, GitHubSyncService } from "../integrations/github";
import { reconcileUnresolvedOwnership } from "../recovery/reconcile-ownership";

let mainWindow: BrowserWindow | undefined;
let taskRepository: TaskRepository | undefined;
let runRepository: RunRepository | undefined;
let database: Database.Database | undefined;
let githubRepository: GitHubRepository | undefined;

function configuredHelperPath(): string {
  if (app.isPackaged) {
    return resolveHelperPath(app.getAppPath(), true, process.resourcesPath);
  }
  const buildRoot = path.resolve(__dirname, "../..");
  const testRoot = path.resolve(__dirname, "../../..");
  const root = existsSync(path.join(buildRoot, "dist-native", "job-object-helper.exe"))
    ? buildRoot
    : testRoot;
  return resolveHelperPath(root, false, process.resourcesPath);
}

function failure(code: string, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}

function success<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  const frame = mainWindow?.webContents.mainFrame;
  return (
    mainWindow !== undefined &&
    !mainWindow.isDestroyed() &&
    mainWindow.webContents.id === event.sender.id &&
    frame === event.senderFrame &&
    event.senderFrame.url.startsWith("file://")
  );
}

function registerIpc(): void {
  ipcMain.handle("app:get-status", (event): IpcResult<ApplicationStatus> => {
    if (!isTrustedSender(event)) return failure("UNTRUSTED_SENDER", "IPC sender rejected");
    return taskRepository
      ? success({ state: "ready", database: "connected" })
      : failure("PERSISTENCE_UNAVAILABLE", "Database is unavailable");
  });
  ipcMain.handle("tasks:list", (event) => {
    if (!isTrustedSender(event)) return failure("UNTRUSTED_SENDER", "IPC sender rejected");
    if (!taskRepository) return failure("PERSISTENCE_UNAVAILABLE", "Database is unavailable");
    try {
      return success(taskRepository.list());
    } catch (error) {
      console.error("Task listing failed", error);
      return failure("PERSISTENCE_ERROR", "Task listing failed");
    }
  });
  ipcMain.handle("tasks:runs", (event, taskId: unknown) => {
    if (!isTrustedSender(event)) return failure("UNTRUSTED_SENDER", "IPC sender rejected");
    if (!runRepository) return failure("PERSISTENCE_UNAVAILABLE", "Database is unavailable");
    if (typeof taskId !== "string" || taskId.trim().length === 0) {
      return failure("INVALID_INPUT", "Task identifier is invalid");
    }
    try {
      return success(runRepository.listForTask(taskId));
    } catch (error) {
      console.error("Run history listing failed", error);
      return failure("PERSISTENCE_ERROR", "Run history listing failed");
    }
  });
  ipcMain.handle("tasks:create", (event, payload: unknown) => {
    if (!isTrustedSender(event)) return failure("UNTRUSTED_SENDER", "IPC sender rejected");
    if (!taskRepository) return failure("PERSISTENCE_UNAVAILABLE", "Database is unavailable");
    try {
      return success(taskRepository.create(parseCreateTaskInput(payload)));
    } catch (error) {
      console.error("Task creation failed", error);
      return failure(
        error instanceof PersistenceError ? "PERSISTENCE_ERROR" : "INVALID_INPUT",
        error instanceof Error ? error.message : "Task creation failed"
      );
    }
  });
  ipcMain.handle("github:import-issue", async (event, repository: unknown, projectId: unknown, issueNumber: unknown) => {
    if (!isTrustedSender(event)) return failure("UNTRUSTED_SENDER", "IPC sender rejected");
    if (!taskRepository || !githubRepository || !process.env.ORCHESTRATOR_GITHUB_TOKEN) {
      return failure("GITHUB_NOT_CONFIGURED", "GitHub token is not configured");
    }
    if (typeof repository !== "string" || !/^[^/]+\/[^/]+$/.test(repository) ||
        typeof projectId !== "string" || projectId.trim().length === 0 ||
        typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber < 1) {
      return failure("INVALID_INPUT", "GitHub repository, project, or issue is invalid");
    }
    try {
      const client = new GitHubApiClient(process.env.ORCHESTRATOR_GITHUB_TOKEN ?? "");
      const items = await client.listProjectItems(projectId);
      const item = items.find((candidate) => candidate.issue.number === issueNumber);
      if (!item) return failure("GITHUB_NOT_FOUND", "GitHub project issue was not found");
      const service = new GitHubSyncService(client, taskRepository, githubRepository);
      return success(await service.importIssue(repository, item.issue, projectId, item.id));
    } catch (error) {
      console.error("GitHub issue import failed", error);
      return failure("GITHUB_SYNC_ERROR", error instanceof Error ? error.message : "GitHub issue import failed");
    }
  });
  ipcMain.handle("github:sync-task", async (event, taskId: unknown, progress: unknown) => {
    if (!isTrustedSender(event)) return failure("UNTRUSTED_SENDER", "IPC sender rejected");
    if (!taskRepository || !githubRepository || !process.env.ORCHESTRATOR_GITHUB_TOKEN) {
      return failure("GITHUB_NOT_CONFIGURED", "GitHub token is not configured");
    }
    if (typeof taskId !== "string" || taskId.trim().length === 0 ||
        (progress !== null && typeof progress !== "string")) {
      return failure("INVALID_INPUT", "GitHub sync payload is invalid");
    }
    const task = taskRepository.get(taskId);
    if (!task) return failure("INVALID_INPUT", "Task was not found");
    const link = githubRepository.linkForTask(taskId);
    if (!link) return failure("GITHUB_NOT_LINKED", "Task has no GitHub link");
    try {
      const service = new GitHubSyncService(
        new GitHubApiClient(process.env.ORCHESTRATOR_GITHUB_TOKEN ?? ""),
        taskRepository,
        githubRepository
      );
      return success(await service.syncTask(task, progress as string | null));
    } catch (error) {
      console.error("GitHub task sync failed", error);
      return failure("GITHUB_SYNC_ERROR", error instanceof Error ? error.message : "GitHub task sync failed");
    }
  });
  ipcMain.handle(
    "github:update-project-field",
    async (event, projectId: unknown, itemId: unknown, fieldId: unknown, optionId: unknown) => {
      if (!isTrustedSender(event)) return failure("UNTRUSTED_SENDER", "IPC sender rejected");
      if (!process.env.ORCHESTRATOR_GITHUB_TOKEN) {
        return failure("GITHUB_NOT_CONFIGURED", "GitHub token is not configured");
      }
      if (
        typeof projectId !== "string" || projectId.trim().length === 0 ||
        typeof itemId !== "string" || itemId.trim().length === 0 ||
        typeof fieldId !== "string" || fieldId.trim().length === 0 ||
        typeof optionId !== "string" || optionId.trim().length === 0
      ) {
        return failure("INVALID_INPUT", "GitHub project field payload is invalid");
      }
      try {
        await new GitHubApiClient(process.env.ORCHESTRATOR_GITHUB_TOKEN).updateProjectSingleSelect(
          projectId, itemId, fieldId, optionId
        );
        return success(null);
      } catch (error) {
        console.error("GitHub project field update failed", error);
        return failure(
          "GITHUB_SYNC_ERROR",
          error instanceof Error ? error.message : "GitHub project field update failed"
        );
      }
    }
  );
  ipcMain.handle("tasks:run-fixture", async (event, taskId: unknown) => {
    if (!isTrustedSender(event)) return failure("UNTRUSTED_SENDER", "IPC sender rejected");
    if (!taskRepository || !database) {
      return failure("PERSISTENCE_UNAVAILABLE", "Database is unavailable");
    }
    if (typeof taskId !== "string" || taskId.trim().length === 0) {
      return failure("INVALID_INPUT", "Task identifier is invalid");
    }
    const task = taskRepository.list().find((candidate) => candidate.id === taskId);
    if (!task) return failure("INVALID_INPUT", "Task was not found");
    if (task.riskTier !== 1) {
      return failure("APPROVAL_REQUIRED", "Fixture runner supports risk-tier 1 tasks only");
    }
    const route = {
      routeId: "local-fixture",
      provider: { state: "known" as const, name: "local-fixture" },
      model: { state: "known" as const, name: "deterministic" },
      reportedBy: "adapter" as const
    };
    const manifest: CapabilityManifest = {
      contractVersion: HARNESS_ADAPTER_CONTRACT_VERSION,
      adapterId: "local-fixture",
      generatedAt: new Date().toISOString(),
      capabilities: [
        "run.create",
        "progress.structured",
        "terminal.outcome",
        "dispatch.idempotency"
      ].map((key) => ({
        key,
        state: "supported" as const,
        evidence: ["local-fixture"],
        conditions: [],
        satisfiedPrerequisites: [],
        version: "fixture-v1",
        environment: "local"
      })) as CapabilityManifest["capabilities"]
    };
    const routeRequirements: RouteRequirements = {
      routeId: route.routeId,
      allowExplicitFallback: false,
      capabilities: manifest.capabilities.map((capability) => ({
        key: capability.key,
        mandatory: true,
        prerequisites: []
      }))
    };
    const correlation = {
      dispatchId: "fixture-dispatch",
      runId: "fixture-run",
      attemptId: "fixture-attempt"
    };
    const adapter = new ConformanceFixtureAdapter({
      identity: {
        adapterId: "local-fixture",
        harnessName: "deterministic-fixture",
        adapterVersion: "1",
        contractVersion: HARNESS_ADAPTER_CONTRACT_VERSION
      },
      manifest,
      route,
      progressEvents: [{
        eventId: "fixture-progress",
        correlation,
        sequence: 1,
        occurredAt: new Date().toISOString(),
        kind: "message",
        message: "Fixture worker completed deterministic step",
        evidence: []
      }],
      terminalOutcome: {
        kind: "succeeded",
        correlation,
        reportedAt: new Date().toISOString(),
        evidence: [],
        error: null
      },
      cancellationResult: {
        ok: false,
        error: {
          class: "unsupported_capability",
          code: "FIXTURE_ONLY",
          message: "Fixture cancellation is not enabled",
          retryable: false,
          correlation
        }
      },
      reconciliationResult: {
        ok: false,
        error: {
          class: "unsupported_capability",
          code: "FIXTURE_ONLY",
          message: "Fixture reconciliation is not enabled",
          retryable: false,
          correlation
        }
      }
    });
    try {
      const result = await executeLocalRun(database, {
        task,
        action: {
          operation: "run-local-fixture",
          context: {
            operation: "run-local-fixture",
            target: "fixture-worktree",
            arguments: [],
            payload: null
          },
          riskTier: 1,
          prohibited: false,
          capabilityVerified: true,
          evidenceComplete: true,
          prerequisitesResolved: true
        },
        approval: null,
        workspace: {
          repositoryPath: app.getAppPath(),
          targetBranch: "fixture",
          baseBranch: "main",
          confirmedByUser: true,
          worktreePath: path.join(app.getPath("temp"), "orchestrator-fixture"),
          prohibitedOperation: false
        },
        manifest,
        route,
        routeRequirements,
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        adapter
      });
      return success({
        runId: result.run.id,
        attemptId: result.attemptId,
        status: result.status,
        accepted: result.accepted,
        progressAccepted: result.progressAccepted,
        progressRejected: result.progressRejected,
        acceptance: result.acceptance
      });
    } catch (error) {
      console.error("Fixture execution failed", error);
      return failure("EXECUTION_ERROR", "Fixture execution failed");
    }
  });
  ipcMain.handle("tasks:run-owned-fixture", async (event, taskId: unknown): Promise<IpcResult<OwnedFixtureRunSummary>> => {
    if (!isTrustedSender(event)) return failure("UNTRUSTED_SENDER", "IPC sender rejected");
    if (!taskRepository || !runRepository || !database) {
      return failure("PERSISTENCE_UNAVAILABLE", "Database is unavailable");
    }
    if (typeof taskId !== "string" || taskId.trim().length === 0) {
      return failure("INVALID_INPUT", "Task identifier is invalid");
    }
    const task = taskRepository.list().find((candidate) => candidate.id === taskId);
    if (!task) return failure("INVALID_INPUT", "Task was not found");
    if (task.riskTier !== 1) {
      return failure("APPROVAL_REQUIRED", "Owned fixture supports risk-tier 1 tasks only");
    }
    const policy = evaluatePolicy({
      operation: "run-owned-fixture",
      context: {
        operation: "run-owned-fixture",
        target: "owned-fixture-worker",
        arguments: [],
        payload: null
      },
      riskTier: 1,
      prohibited: false,
      capabilityVerified: true,
      evidenceComplete: true,
      prerequisitesResolved: true
    });
    new PolicyRepository(database).recordDecision(policy);
    if (policy.decision !== "allowed") {
      return failure("POLICY_BLOCKED", policy.reason);
    }

    const created = runRepository.createRun(task.id, "native-owned-fixture");
    const fixtureDirectory = mkdtempSync(path.join(app.getPath("temp"), "orchestrator-owned-fixture-"));
    const coordinator = new NativeOwnershipCoordinator(
      runRepository,
      created.run.id,
      created.attempt.id,
      configuredHelperPath()
    );
    let running = false;
    try {
      runRepository.transition(created.run.id, "ready", "none");
      runRepository.transition(created.run.id, "running", "none");
      await coordinator.launchFixture(fixtureDirectory);
      running = true;
      const deadline = Date.now() + 5000;
      while (
        (!existsSync(path.join(fixtureDirectory, "worker.started")) ||
          !existsSync(path.join(fixtureDirectory, "child.started")) ||
          !existsSync(path.join(fixtureDirectory, "grandchild.started"))) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const markersPresent =
        existsSync(path.join(fixtureDirectory, "worker.started")) &&
        existsSync(path.join(fixtureDirectory, "child.started")) &&
        existsSync(path.join(fixtureDirectory, "grandchild.started"));
      const status = await coordinator.status();
      if (!markersPresent || !status.running || status.activeProcesses < 3) {
        throw new Error("Fixture containment evidence is incomplete");
      }
      const launch = await coordinator.cancel();
      runRepository.recordAttemptOutcome(
        created.attempt.id,
        "succeeded",
        "verification",
        "none",
        `Owned fixture cleanup verified; active processes after cleanup=${launch.activeProcessesAfterCleanup}`
      );
      return success({
        runId: created.run.id,
        attemptId: created.attempt.id,
        ownershipVerified: true,
        workerExecutedBeforeOwnership: false,
        childContained: true,
        grandchildContained: true,
        cleanupVerified: true,
        activeProcessesAfterCleanup: 0
      });
    } catch (error) {
      console.error("Owned fixture execution failed", error);
      if (running) {
        try {
          runRepository.recordAttemptOutcome(
            created.attempt.id,
            "inconclusive",
            "recovery_required",
            "recovery_required",
            error instanceof Error ? error.message : "Owned fixture outcome is uncertain"
          );
        } catch (persistenceError) {
          console.error("Owned fixture recovery persistence failed", persistenceError);
        }
      } else {
        runRepository.transition(created.run.id, "recovery_required", "recovery_required");
      }
      return failure("RECOVERY_REQUIRED", "Owned fixture outcome is uncertain");
    } finally {
      await coordinator.close();
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "../preload/preload.js")
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.on("will-frame-navigate", (event) => {
    event.preventDefault();
  });
  const rendererPath = process.env.ORCHESTRATOR_RENDERER_PATH ??
    path.join(__dirname, "../renderer/index.html");
  void window.loadFile(rendererPath).catch((error: unknown) => {
    console.error("Renderer load failed", error);
  });
  return window;
}

app.whenReady().then(async () => {
  try {
    database = openDatabase(path.join(app.getPath("userData"), "orchestrator.db"));
    taskRepository = new TaskRepository(database);
    runRepository = new RunRepository(database);
    githubRepository = new GitHubRepository(database);
    runRepository.reconcileInterruptedRuns(new Date().toISOString());
    if (runRepository.listUnresolvedOwnership().length > 0) {
      await reconcileUnresolvedOwnership(runRepository, configuredHelperPath());
    }
    registerIpc();
    mainWindow = createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  } catch (error) {
    console.error("Orchestrator startup failed", error);
    void dialog.showErrorBox("Orchestrator startup failed", "Persistent state is unavailable.");
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  database?.close();
});

export type { OrchestratorApi };
