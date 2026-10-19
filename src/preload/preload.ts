import { contextBridge, ipcRenderer } from "electron";
import type { CreateTaskInput, OrchestratorApi } from "../shared/ipc";

const api: OrchestratorApi = {
  getStatus: () => ipcRenderer.invoke("app:get-status"),
  listTasks: () => ipcRenderer.invoke("tasks:list"),
  listRuns: (taskId: string) => ipcRenderer.invoke("tasks:runs", taskId),
  createTask: (input: CreateTaskInput) => ipcRenderer.invoke("tasks:create", input),
  runFixture: (taskId: string) => ipcRenderer.invoke("tasks:run-fixture", taskId),
  runOwnedFixture: (taskId: string) => ipcRenderer.invoke("tasks:run-owned-fixture", taskId),
  importGitHubIssue: (repository: string, projectId: string, issueNumber: number) =>
    ipcRenderer.invoke("github:import-issue", repository, projectId, issueNumber),
  syncGitHubTask: (taskId: string, progress: string | null) =>
    ipcRenderer.invoke("github:sync-task", taskId, progress),
  updateGitHubProjectField: (projectId: string, itemId: string, fieldId: string, optionId: string) =>
    ipcRenderer.invoke("github:update-project-field", projectId, itemId, fieldId, optionId)
};

contextBridge.exposeInMainWorld("orchestrator", api);
