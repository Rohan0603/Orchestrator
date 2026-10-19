import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import Database from "better-sqlite3";
import { openDatabase } from "../src/persistence/database";
import { TaskRepository } from "../src/persistence/task-repository";
import {
  GitHubRepository,
  GitHubSyncService,
  type GitHubIssue,
  type GitHubPort
} from "../src/integrations/github";
import {
  CodeRabbitReviewLoop,
  CodeRabbitReviewRepository,
  detectCodeRabbitConfiguration,
  type CodeRabbitPort
} from "../src/integrations/coderabbit";

function issue(updatedAt: string, state: "open" | "closed" = "open"): GitHubIssue {
  return {
    id: "issue-node-1",
    number: 7,
    title: "Imported issue",
    body: "Do work",
    state,
    updatedAt,
    htmlUrl: "https://github.com/acme/repo/issues/7"
  };
}

test("GitHub issue import, idempotency, status sync, and conflict are durable", async () => {
  const database = openDatabase(":memory:");
  const tasks = new TaskRepository(database);
  const links = new GitHubRepository(database);
  let remote = issue("2026-10-18T00:00:00.000Z");
  const comments: string[] = [];
  const port: GitHubPort = {
    async listIssues() { return [remote]; },
    async listProjectItems() { return [{ id: "item-1", issue: remote }]; },
    async listProjectFields() { return []; },
    async updateProjectSingleSelect() {},
    async updateIssue(_repository, _number, state) {
      remote = issue("2026-10-18T00:00:01.000Z", state);
      return remote;
    },
    async addComment(_repository, _number, body) { comments.push(body); }
  };
  const service = new GitHubSyncService(port, tasks, links);
  const imported = await service.importIssue("acme/repo", remote, "project-1", "item-1");
  const repeated = await service.importIssue("acme/repo", remote, "project-1", "item-1");
  assert.equal(imported.action, "imported");
  assert.equal(repeated.action, "synced");
  assert.equal(tasks.list().length, 1);
  tasks.updateStatus(imported.task.id, "completed");
  const synced = await service.syncTask(tasks.get(imported.task.id)!, "verification passed");
  assert.equal(synced.action, "synced");
  assert.equal(remote.state, "closed");
  assert.deepEqual(comments, ["verification passed"]);
  remote = issue("2026-10-18T00:01:00.000Z", "open");
  const conflict = await service.syncTask(tasks.get(imported.task.id)!, null);
  assert.equal(conflict.action, "conflict");
  assert.equal(conflict.link.syncState, "conflict");
  assert.equal(links.listSyncEvents(imported.task.id).length, 3);
  links.recordPullRequest(imported.task.id, "orchestrator/issue-7", 12, "https://github.com/acme/repo/pull/12");
  assert.equal(links.linkForTask(imported.task.id)?.pullRequestNumber, 12);
  const outage = new GitHubSyncService({
    async listIssues() { throw new Error("API outage"); },
    async listProjectItems() { return []; },
    async listProjectFields() { return []; },
    async updateProjectSingleSelect() {},
    async updateIssue() { throw new Error("unreachable"); },
    async addComment() { throw new Error("unreachable"); }
  }, tasks, links);
  await assert.rejects(() => outage.syncTask(tasks.get(imported.task.id)!), /API outage/);
  assert.equal(links.linkForTask(imported.task.id)?.syncState, "error");
  database.close();
});

test("CodeRabbit config conflicts fail closed and review loop is bounded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-coderabbit-"));
  writeFileSync(join(directory, "tsconfig.json"), "{}");
  writeFileSync(join(directory, ".coderabbit.yaml"), "reviews:\n  profile: chill\n");
  writeFileSync(join(directory, ".coderabbit.yml"), "reviews: {}\n");
  const config = detectCodeRabbitConfiguration(directory);
  assert.equal(config.profile, "chill");
  assert.equal(config.conflictingPaths.length, 2);
  const database = openDatabase(":memory:");
  const taskRepository = new TaskRepository(database);
  const task = taskRepository.create({
    title: "CodeRabbit fixture",
    description: "review",
    acceptanceCriteria: ["review"],
    riskTier: 1
  });
  const repository = new CodeRabbitReviewRepository(database);
  let requests = 0;
  let reviews = 0;
  const port: CodeRabbitPort = {
    async requestReview() { requests += 1; },
    async getReview() {
      reviews += 1;
      return {
        pullRequestNumber: 9,
        source: "fixture",
        findings: [{ id: "finding-1", severity: "medium", body: "Fix test", resolved: false }]
      };
    }
  };
  const loop = new CodeRabbitReviewLoop(port, repository, 2);
  const result = await loop.run(task.id, null, "acme/repo", 9, async () => true);
  assert.equal(result, "blocked");
  assert.equal(requests, 2);
  assert.equal(reviews, 2);
  assert.equal(repository.list(task.id).length, 2);
  database.close();
});
