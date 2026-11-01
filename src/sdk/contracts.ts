import type { AuditEvent, Attempt, Run, Task } from "../shared/domain";
import type { OpenAICompatibleAdapter } from "../harness/openai-compatible-adapter";
import type { CreateTaskInput } from "../shared/ipc";

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly repositoryPath: string | null;
  readonly defaultBranch: string | null;
  readonly createdAt: string;
}

export interface CreateProjectInput {
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly repositoryPath?: string | null;
  readonly defaultBranch?: string | null;
}

export interface OrchestratorSdkOptions {
  /** Maximum active worker leases across all workers. Defaults to one. */
  readonly maxActiveRuns?: number;
  /** Maximum active worker leases owned by one worker. Defaults to one. */
  readonly maxActiveRunsPerWorker?: number;
}

export interface TaskRevisionInfo {
  readonly id: string;
  readonly taskId: string;
  readonly revision: number;
  readonly snapshotJson: string;
  readonly contentHash: string;
  readonly createdAt: string;
}

export interface TaskDependencyInfo {
  readonly taskId: string;
  readonly dependsOnTaskId: string;
  readonly createdAt: string;
}

export interface WorkerCapability {
  readonly key: string;
  readonly version?: string;
}

export interface WorkerRegistration {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly capabilities: readonly WorkerCapability[];
  readonly status: "registered" | "online" | "offline" | "suspended";
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
}

export interface RegisterWorkerInput {
  readonly id?: string;
  readonly name: string;
  readonly kind?: string;
  readonly capabilities?: readonly WorkerCapability[];
}

export interface SkillRecord {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly sourcePath: string;
  readonly description: string;
  readonly instructions: string;
  readonly contentHash: string;
  readonly enabled: boolean;
  readonly createdAt: string;
}

export interface InstallSkillInput {
  readonly id?: string;
  readonly name: string;
  readonly version: string;
  readonly sourcePath: string;
  readonly description?: string;
  readonly instructions: string;
  readonly enabled?: boolean;
}

export interface McpServerRecord {
  readonly id: string;
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly command: string | null;
  readonly arguments: readonly string[];
  readonly url: string | null;
  readonly environment: Readonly<Record<string, string>>;
  readonly description: string;
  readonly enabled: boolean;
  readonly createdAt: string;
}

export interface InstallMcpServerInput {
  readonly id?: string;
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly command?: string | null;
  readonly arguments?: readonly string[];
  readonly url?: string | null;
  readonly environment?: Readonly<Record<string, string>>;
  readonly description?: string;
  readonly enabled?: boolean;
}

export interface InstallPluginInput {
  readonly id?: string;
  readonly name: string;
  readonly version: string;
  readonly entrypoint: string;
  readonly capabilities?: readonly string[];
  readonly enabled?: boolean;
}

export interface PluginRecord {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly entrypoint: string;
  readonly capabilities: readonly string[];
  readonly enabled: boolean;
  readonly createdAt: string;
}

export interface WorkerLease {
  readonly id: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly state: "active" | "expired" | "completed" | "released";
  readonly expiresAt: string;
  readonly lastHeartbeatAt: string;
  readonly createdAt: string;
}

export interface TaskAssignment {
  readonly task: Task;
  readonly run: Run;
  readonly attempt: Attempt;
  readonly lease: WorkerLease;
  readonly handoff: HandoffContext;
}

export interface HandoffContext {
  readonly protocolVersion: "orchestrator-worker-v1";
  readonly correlation: {
    readonly taskId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly leaseToken: string;
  };
  readonly acceptanceCriteria: readonly string[];
  readonly selectedSkills: readonly Pick<SkillRecord, "id" | "name" | "version" | "instructions">[];
  readonly selectedMcpServers: readonly Pick<McpServerRecord, "id" | "name" | "transport" | "description">[];
  readonly selectedPlugins: readonly Pick<PluginRecord, "id" | "name" | "version" | "capabilities">[];
  readonly tokenBudget: number | null;
}

export type WorkerMessageKind = "handoff" | "progress" | "heartbeat" | "report" | "error";

export interface WorkerMessage {
  readonly id: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly workerId: string | null;
  readonly direction: "orchestrator_to_worker" | "worker_to_orchestrator";
  readonly kind: WorkerMessageKind;
  readonly sequence: number;
  readonly payload: unknown;
  readonly idempotencyKey: string | null;
  readonly createdAt: string;
}

export interface WorkerMessageInput {
  readonly leaseToken: string;
  readonly kind: Exclude<WorkerMessageKind, "handoff">;
  readonly sequence: number;
  readonly payload: unknown;
  readonly idempotencyKey?: string;
}

export interface WorkerReportInput {
  readonly leaseToken: string;
  readonly sequence: number;
  readonly outcome: "succeeded" | "failed" | "cancelled" | "inconclusive";
  readonly summary: string;
  readonly evidence?: readonly {
    readonly kind: "diff" | "artifact" | "check" | "review" | "log";
    readonly uri?: string | null;
    readonly contentHash?: string | null;
    readonly criterionIds?: readonly string[];
  }[];
}

export interface McpToolRequest {
  readonly leaseToken: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly sequence: number;
  readonly idempotencyKey?: string;
  readonly approvalId?: string;
}

export interface PluginExecutionRequest {
  readonly leaseToken: string;
  readonly pluginId: string;
  readonly capability: string;
  readonly input: unknown;
  readonly sequence: number;
  readonly idempotencyKey?: string;
  readonly approvalId?: string;
}

export interface RunUsage {
  readonly runId: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly recordedAt: string;
}

export type RunStreamEvent =
  | { readonly kind: "audit"; readonly event: AuditEvent }
  | { readonly kind: "worker_message"; readonly message: WorkerMessage }
  | { readonly kind: "progress"; readonly event: unknown };

export type LlmTaskStreamEvent =
  | { readonly kind: "started"; readonly run: Run; readonly attempt: Attempt }
  | { readonly kind: "delta"; readonly runId: string; readonly sequence: number; readonly text: string }
  | { readonly kind: "usage"; readonly runId: string; readonly usage: RunUsage }
  | { readonly kind: "completed"; readonly run: Run; readonly outcome: "succeeded" | "failed" | "inconclusive" };

export interface OrchestratorSdk {
  createProject(input: CreateProjectInput): Project;
  createTask(input: CreateTaskInput): Task;
  listTaskRevisions(taskId: string): readonly TaskRevisionInfo[];
  addTaskDependency(taskId: string, dependsOnTaskId: string): TaskDependencyInfo;
  listTaskDependencies(taskId: string): readonly TaskDependencyInfo[];
  registerWorker(input: RegisterWorkerInput): WorkerRegistration;
  installSkill(input: InstallSkillInput): SkillRecord;
  installMcpServer(input: InstallMcpServerInput): McpServerRecord;
  installPlugin(input: InstallPluginInput): PluginRecord;
  claimTask(workerId: string, leaseDurationMs?: number, approvalId?: string): TaskAssignment | null;
  retryRecoveredTask(taskId: string, workerId: string, approvalId?: string): TaskAssignment | null;
  heartbeat(leaseToken: string, leaseDurationMs?: number): WorkerLease;
  sendWorkerMessage(workerId: string, input: WorkerMessageInput): WorkerMessage;
  reportTask(workerId: string, input: WorkerReportInput): void;
  dispatchInternalMessages(now?: string, limit?: number): readonly string[];
  listMcpTools(workerId: string, leaseToken: string, serverId: string, approvalId?: string): Promise<readonly import("./capability-runtime").McpTool[]>;
  callMcpTool(workerId: string, input: McpToolRequest): Promise<import("./capability-runtime").McpToolResult>;
  executePlugin(workerId: string, input: PluginExecutionRequest): Promise<unknown>;
  streamTask(taskId: string, adapter: OpenAICompatibleAdapter, options?: { readonly deadlineAt?: string; readonly systemPrompt?: string }): AsyncIterable<LlmTaskStreamEvent>;
  streamRun(runId: string, options?: { readonly pollMs?: number; readonly signal?: AbortSignal }): AsyncIterable<RunStreamEvent>;
}
