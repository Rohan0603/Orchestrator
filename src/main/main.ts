import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { openDatabase, PersistenceError } from "../persistence/database";
import type Database from "better-sqlite3";
import { TaskRepository } from "../persistence/task-repository";
import { RunRepository } from "../persistence/run-repository";
import { ConformanceFixtureAdapter } from "../harness/conformance-fixture";
import { executeLocalRun } from "../execution/local-execution";
import {
  parseCreateTaskInput,
  type ApplicationStatus,
  type IpcResult,
  type OrchestratorApi
} from "../shared/ipc";
import {
  HARNESS_ADAPTER_CONTRACT_VERSION,
  type CapabilityManifest,
  type RouteRequirements
} from "../harness/adapter-contract";

let mainWindow: BrowserWindow | undefined;
let taskRepository: TaskRepository | undefined;
let runRepository: RunRepository | undefined;
let database: Database.Database | undefined;

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
        progressRejected: result.progressRejected
      });
    } catch (error) {
      console.error("Fixture execution failed", error);
      return failure("EXECUTION_ERROR", "Fixture execution failed");
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

app.whenReady().then(() => {
  try {
    database = openDatabase(path.join(app.getPath("userData"), "orchestrator.db"));
    taskRepository = new TaskRepository(database);
    runRepository = new RunRepository(database);
    runRepository.reconcileInterruptedRuns(new Date().toISOString());
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
