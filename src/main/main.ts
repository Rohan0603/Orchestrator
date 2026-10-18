import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { openDatabase, PersistenceError } from "../persistence/database";
import type Database from "better-sqlite3";
import { TaskRepository } from "../persistence/task-repository";
import {
  parseCreateTaskInput,
  type ApplicationStatus,
  type IpcResult,
  type OrchestratorApi
} from "../shared/ipc";

let mainWindow: BrowserWindow | undefined;
let taskRepository: TaskRepository | undefined;
let database: Database.Database | undefined;

function failure(code: string, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}

function success<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  return mainWindow?.webContents.id === event.sender.id;
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
  void window.loadFile(path.join(__dirname, "../renderer/index.html")).catch((error: unknown) => {
    console.error("Renderer load failed", error);
  });
  return window;
}

app.whenReady().then(() => {
  try {
    database = openDatabase(path.join(app.getPath("userData"), "orchestrator.db"));
    taskRepository = new TaskRepository(database);
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
