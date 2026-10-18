import { contextBridge, ipcRenderer } from "electron";
import type { CreateTaskInput, OrchestratorApi } from "../shared/ipc";

const api: OrchestratorApi = {
  getStatus: () => ipcRenderer.invoke("app:get-status"),
  listTasks: () => ipcRenderer.invoke("tasks:list"),
  createTask: (input: CreateTaskInput) => ipcRenderer.invoke("tasks:create", input)
};

contextBridge.exposeInMainWorld("orchestrator", api);
