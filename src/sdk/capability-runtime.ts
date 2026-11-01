import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { McpServerRecord, PluginRecord } from "./contracts";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 8192;

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface McpToolResult {
  readonly content: readonly unknown[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

export interface McpClient {
  listTools(): Promise<readonly McpTool[]>;
  callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<McpToolResult>;
  close(): Promise<void>;
}

interface JsonRpcResponse {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function parseResult(value: unknown): McpToolResult {
  if (!value || typeof value !== "object") throw new Error("MCP returned an invalid result");
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.content)) throw new Error("MCP result has no content array");
  return {
    content: result.content,
    isError: result.isError === true,
    structuredContent: result.structuredContent
  };
}

class JsonRpcStdioClient implements McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private nextId = 1;
  private stderr = "";
  private closed = false;
  private initialized = false;

  public constructor(
    private readonly server: McpServerRecord,
    private readonly timeoutMs: number
  ) {
    if (!server.command) throw new Error("stdio MCP server has no command");
    const environment = { ...process.env, ...server.environment };
    this.child = spawn(server.command, [...server.arguments], {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-MAX_ERROR_BYTES);
    });
    this.child.on("error", (cause) => this.failAll(cause instanceof Error ? cause : new Error("MCP process failed")));
    this.child.on("close", (code, signal) => this.failAll(new Error(`MCP process exited (${code ?? "unknown"}, ${signal ?? "no signal"})`)));
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "orchestrator", version: "1" }
    });
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  public async listTools(): Promise<readonly McpTool[]> {
    await this.initialize();
    const result = await this.request("tools/list", {});
    if (!result || typeof result !== "object" || !Array.isArray((result as { tools?: unknown }).tools)) {
      throw new Error("MCP tools/list returned an invalid result");
    }
    return (result as { tools: McpTool[] }).tools;
  }

  public async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<McpToolResult> {
    await this.initialize();
    return parseResult(await this.request("tools/call", { name, arguments: args }));
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("MCP client closed"));
    if (!this.child.killed) this.child.kill();
  }

  private consume(chunk: Buffer): void {
    this.buffer = `${this.buffer}${chunk.toString("utf8")}`;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_MESSAGE_BYTES) {
      void this.close();
      return;
    }
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        this.failAll(new Error("MCP emitted invalid JSON"));
        return;
      }
      if (typeof response.id !== "number") continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(`${text(response.error.message, "MCP request failed")} (${response.error.code ?? "unknown"})`));
      else pending.resolve(response.result);
    }
  }

  private notify(method: string, params: unknown): void {
    if (this.closed || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed || !this.child.stdin.writable) return Promise.reject(new Error(`MCP server is unavailable: ${this.stderr}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class JsonRpcHttpClient implements McpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;

  public constructor(private readonly server: McpServerRecord, private readonly timeoutMs: number) {
    if (!server.url) throw new Error("HTTP MCP server has no URL");
  }

  public async listTools(): Promise<readonly McpTool[]> {
    await this.initialize();
    const result = await this.request("tools/list", {});
    if (!result || typeof result !== "object" || !Array.isArray((result as { tools?: unknown }).tools)) throw new Error("MCP tools/list returned an invalid result");
    return (result as { tools: McpTool[] }).tools;
  }

  public async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<McpToolResult> {
    await this.initialize();
    return parseResult(await this.request("tools/call", { name, arguments: args }));
  }

  public async close(): Promise<void> {}

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "orchestrator", version: "1" }
    });
    this.initialized = true;
    // HTTP MCP servers receive initialized as a notification on the same endpoint.
    await this.notify("notifications/initialized", {});
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.server.url!, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {})
        },
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`MCP notification failed: ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.server.url!, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {})
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal: controller.signal
      });
      const session = response.headers.get("mcp-session-id");
      if (session) this.sessionId = session;
      if (!response.ok) throw new Error(`MCP HTTP request failed: ${response.status}`);
      const body = await response.text();
      const line = body.split(/\r?\n/).find((value) => value.startsWith("data:"));
      const payload = line ? line.slice(5).trim() : body;
      const parsed = JSON.parse(payload) as JsonRpcResponse;
      if (parsed.error) throw new Error(`${text(parsed.error.message, "MCP request failed")} (${parsed.error.code ?? "unknown"})`);
      return parsed.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createMcpClient(server: McpServerRecord, timeoutMs = 30_000): McpClient {
  if (server.transport === "stdio") {
    const client = new JsonRpcStdioClient(server, timeoutMs);
    return {
      listTools: () => client.listTools(),
      callTool: (name, args) => client.callTool(name, args),
      close: () => client.close()
    };
  }
  const client = new JsonRpcHttpClient(server, timeoutMs);
  return {
    listTools: () => client.listTools(),
    callTool: (name, args) => client.callTool(name, args),
    close: () => client.close()
  };
}

export interface PluginContext {
  readonly runId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly workerId: string;
}

export interface OrchestratorPlugin {
  execute(capability: string, input: unknown, context: PluginContext): Promise<unknown> | unknown;
}

export async function executePlugin(
  plugin: PluginRecord,
  capability: string,
  input: unknown,
  context: PluginContext,
  timeoutMs = 30_000
): Promise<unknown> {
  if (!plugin.enabled) throw new Error("Plugin is disabled");
  if (!plugin.capabilities.includes(capability)) throw new Error("Plugin capability is not declared");
  const entrypoint = path.isAbsolute(plugin.entrypoint) ? plugin.entrypoint : path.resolve(plugin.entrypoint);
  const loaded = createRequire(__filename)(entrypoint) as { createPlugin?: unknown; default?: unknown };
  const factory = loaded.createPlugin ?? loaded.default ?? loaded;
  const instance: OrchestratorPlugin = typeof factory === "function" ? await factory() : factory;
  if (!instance || typeof instance.execute !== "function") throw new Error("Plugin does not export an executable plugin");
  return Promise.race([
    Promise.resolve(instance.execute(capability, input, context)),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Plugin execution timed out")), timeoutMs))
  ]);
}
