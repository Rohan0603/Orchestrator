import { contextBridge, ipcRenderer } from "electron";
import type { CreateTaskInput, OrchestratorApi } from "../shared/ipc";

const api: OrchestratorApi = {
  getStatus: () => ipcRenderer.invoke("app:get-status"),
  listTasks: () => ipcRenderer.invoke("tasks:list"),
  listRuns: (taskId: string) => ipcRenderer.invoke("tasks:runs", taskId),
  createTask: (input: CreateTaskInput) => ipcRenderer.invoke("tasks:create", input),
  runFixture: (taskId: string) => ipcRenderer.invoke("tasks:run-fixture", taskId)
};

contextBridge.exposeInMainWorld("orchestrator", api);
