import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { PersistenceError } from "../persistence/database";

export interface CodeRabbitFinding {
  readonly id: string;
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly body: string;
  readonly resolved: boolean;
}

export interface CodeRabbitReview {
  readonly pullRequestNumber: number;
  readonly findings: readonly CodeRabbitFinding[];
  readonly source: "live" | "fixture";
}

export interface CodeRabbitPort {
  requestReview(repository: string, pullRequestNumber: number): Promise<void>;
  getReview(repository: string, pullRequestNumber: number): Promise<CodeRabbitReview | null>;
}

export class GitHubCodeRabbitPort implements CodeRabbitPort {
  public constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.github.com"
  ) {
    if (!token.trim()) throw new Error("GitHub token is required");
  }

  public async requestReview(repository: string, pullRequestNumber: number): Promise<void> {
    await this.request(`/repos/${repositoryPath(repository)}/issues/${pullRequestNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "@coderabbitai review" })
    });
  }

  public async getReview(repository: string, pullRequestNumber: number): Promise<CodeRabbitReview | null> {
    const value = await this.request(`/repos/${repositoryPath(repository)}/issues/${pullRequestNumber}/comments`);
    if (!Array.isArray(value)) throw new Error("CodeRabbit comments response was invalid");
    const comments = value.filter((comment): comment is { user?: { login?: string }; body?: string } =>
      typeof comment === "object" && comment !== null
    ).filter((comment) => comment.user?.login?.toLowerCase().includes("coderabbit"));
    if (comments.length === 0) return null;
    return {
      pullRequestNumber,
      source: "live",
      findings: comments.map((comment, index) => ({
        id: `coderabbit-comment-${index + 1}`,
        severity: "medium" as const,
        body: comment.body ?? "",
        resolved: false
      }))
    };
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${pathname}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...init.headers
      }
    });
    if (!response.ok) throw new Error(`GitHub CodeRabbit request failed: ${response.status} ${response.statusText}`);
    return response.json();
  }
}

function repositoryPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !part.trim())) {
    throw new Error("GitHub repository must use owner/name format");
  }
  return parts.map((part) => encodeURIComponent(part)).join("/");
}

export interface CodeRabbitConfiguration {
  readonly profile: "chill";
  readonly configPath: string | null;
  readonly conflictingPaths: readonly string[];
  readonly stack: "typescript" | "unknown";
  readonly proposedInstructions: readonly string[];
}

export function detectCodeRabbitConfiguration(repositoryPath: string): CodeRabbitConfiguration {
  const names = [".coderabbit.yaml", ".coderabbit.yml", ".coderabbit.config.ts"];
  const present = names.filter((name) => existsSync(path.join(repositoryPath, name)));
  return {
    profile: "chill",
    configPath: present.includes(".coderabbit.yaml") ? path.join(repositoryPath, ".coderabbit.yaml") : null,
    conflictingPaths: present.length > 1 ? present.map((name) => path.join(repositoryPath, name)) : [],
    stack: existsSync(path.join(repositoryPath, "tsconfig.json")) ? "typescript" : "unknown",
    proposedInstructions: existsSync(path.join(repositoryPath, "tsconfig.json"))
      ? ["Run TypeScript build and focused Electron tests before approval."]
      : []
  };
}

export function readCodeRabbitConfiguration(repositoryPath: string): string | null {
  const detected = detectCodeRabbitConfiguration(repositoryPath);
  if (!detected.configPath || detected.conflictingPaths.length > 0) return null;
  return readFileSync(detected.configPath, "utf8");
}

export class CodeRabbitReviewRepository {
  public constructor(private readonly database: Database.Database) {}

  public record(
    taskId: string,
    runId: string | null,
    review: CodeRabbitReview,
    iteration: number,
    state: "requested" | "received" | "fixing" | "verified" | "blocked"
  ): void {
    try {
      this.database.prepare(
        `INSERT INTO coderabbit_reviews
          (id, task_id, run_id, pull_request_number, iteration, state, source, findings_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(), taskId, runId, review.pullRequestNumber, iteration, state, review.source,
        JSON.stringify(review.findings), new Date().toISOString()
      );
    } catch (error) {
      throw new PersistenceError("CodeRabbit review persistence failed", { cause: error });
    }
  }

  public list(taskId: string): readonly { iteration: number; state: string; findings: readonly CodeRabbitFinding[] }[] {
    try {
      const rows = this.database.prepare(
        "SELECT iteration, state, findings_json FROM coderabbit_reviews WHERE task_id = ? ORDER BY iteration, created_at"
      ).all(taskId) as { iteration: number; state: string; findings_json: string }[];
      return rows.map((row) => ({ iteration: row.iteration, state: row.state, findings: JSON.parse(row.findings_json) as CodeRabbitFinding[] }));
    } catch (error) {
      throw new PersistenceError("CodeRabbit review lookup failed", { cause: error });
    }
  }
}

export class CodeRabbitReviewLoop {
  public constructor(
    private readonly port: CodeRabbitPort,
    private readonly reviews: CodeRabbitReviewRepository,
    private readonly maxIterations = 2
  ) {
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 5) {
      throw new Error("CodeRabbit iteration limit must be between 1 and 5");
    }
  }

  public async run(
    taskId: string,
    runId: string | null,
    repository: string,
    pullRequestNumber: number,
    fix: (findings: readonly CodeRabbitFinding[], iteration: number) => Promise<boolean>
  ): Promise<"verified" | "blocked"> {
    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      await this.port.requestReview(repository, pullRequestNumber);
      const review = await this.port.getReview(repository, pullRequestNumber);
      if (!review) {
        this.reviews.record(taskId, runId, {
          pullRequestNumber,
          findings: [],
          source: "live"
        }, iteration, "blocked");
        return "blocked";
      }
      if (review.findings.length === 0) {
        this.reviews.record(taskId, runId, review, iteration, "verified");
        return "verified";
      }
      this.reviews.record(taskId, runId, review, iteration, iteration === this.maxIterations ? "blocked" : "fixing");
      if (iteration === this.maxIterations || !(await fix(review.findings, iteration))) return "blocked";
    }
    return "blocked";
  }
}
