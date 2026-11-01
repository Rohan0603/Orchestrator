import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runCli } from "../src/cli";

test("headless CLI runs a labelled SQLite fixture and inspects the same persisted task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-cli-"));
  const databasePath = join(directory, "fixture.sqlite");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {stdout: (value: string) => stdout.push(value), stderr: (value: string) => stderr.push(value)};
  try {
    assert.equal(await runCli(["--db", databasePath, "fixture", "demo"], io), 0, stderr.join(""));
    const fixture = JSON.parse(stdout.pop() ?? "null") as {
      fixtureLabel: string;
      projectId: string;
      taskId: string;
      runId: string;
      artifactIds: string[];
      timeline: Array<{source: string}>;
    };
    assert.match(fixture.fixtureLabel, /DEMO FIXTURE/);
    assert.ok(fixture.artifactIds.length > 0);
    assert.ok(fixture.timeline.some((item) => item.source === "worker_message"));

    stdout.length = 0;
    const showExitCode = await runCli(["--db", databasePath, "task", "show", fixture.taskId], io);
    assert.equal(showExitCode, 0, stderr.join(""));
    const detail = JSON.parse(stdout.pop() ?? "null") as {
      task: {id: string; projectId: string; status: string};
      runs: Array<{run: {state: string}}>;
      traces: Array<{timeline: Array<unknown>}>;
      artifacts: Array<{id: string}>;
    };
    assert.equal(detail.task.id, fixture.taskId);
    assert.equal(detail.task.projectId, fixture.projectId);
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.runs[0]?.run.state, "verification");
    assert.equal(detail.traces.length, 1);
    assert.ok(detail.traces[0]?.timeline.length);
    assert.equal(detail.artifacts[0]?.id, fixture.artifactIds[0]);

    stdout.length = 0;
    assert.equal(await runCli(["--db", databasePath, "project", "show", fixture.projectId], io), 0, stderr.join(""));
    const project = JSON.parse(stdout.pop() ?? "null") as {project: {id: string}; tasks: unknown[]};
    assert.equal(project.project.id, fixture.projectId);
    assert.equal(project.tasks.length, 1);

    stdout.length = 0;
    assert.equal(await runCli([
      "--db", databasePath, "task", "create", "--project", fixture.projectId,
      "--title", "Leave queued", "--criteria", "do not claim", "--risk-tier", "1"
    ], io), 0, stderr.join(""));
    assert.equal(await runCli(["--db", databasePath, "fixture", "demo"], io), 1);
    assert.match(stderr.pop() ?? "", /no dispatchable tasks/i);
    stdout.length = 0;
    assert.equal(await runCli(["--db", databasePath, "task", "list"], io), 0);
    assert.equal((JSON.parse(stdout.pop() ?? "[]") as unknown[]).length, 2);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
