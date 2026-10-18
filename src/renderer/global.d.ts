import type { OrchestratorApi } from "../shared/ipc";

declare global {
  interface Window {
    orchestrator: OrchestratorApi;
  }
}

export {};
