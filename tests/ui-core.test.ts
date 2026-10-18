import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { app, BrowserWindow } from "electron";

const directory = mkdtempSync(join(tmpdir(), "orchestrator-ui-"));
const rendererDirectory = join(directory, "renderer");
mkdirSync(rendererDirectory);
copyFileSync("src/renderer/index.html", join(rendererDirectory, "index.html"));
copyFileSync("src/renderer/styles.css", join(rendererDirectory, "styles.css"));
copyFileSync(
  "dist-test/src/renderer/renderer.js",
  join(rendererDirectory, "renderer.js")
);
app.setPath("userData", join(directory, "user-data"));
process.env.ORCHESTRATOR_RENDERER_PATH = join(rendererDirectory, "index.html");
process.once("exit", () => {
  rmSync(directory, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for UI fixture");
}

test("UI creates tasks, prevents duplicate fixture runs, and reports blocked acceptance", async () => {
  try {
    await import("../src/main/main");
    await app.whenReady();
    const window = await waitFor(() => BrowserWindow.getAllWindows()[0]);
    await new Promise<void>((resolve) => {
      if (window.webContents.isLoading()) {
        window.webContents.once("did-finish-load", () => resolve());
      } else {
        resolve();
      }
    });

    const ready = await waitFor(async () => {
      const text = await window.webContents.executeJavaScript(
        "document.querySelector('#status')?.textContent"
      ) as string | undefined;
      return text === "Database: connected" ? text : undefined;
    });
    assert.equal(ready, "Database: connected");

    await window.webContents.executeJavaScript(`
      document.querySelector('[name=title]').value = 'UI fixture task';
      document.querySelector('[name=description]').value = 'Created through renderer';
      document.querySelector('[name=criterion]').value = 'fixture completes';
      document.querySelector('#task-form').requestSubmit();
    `);
    await waitFor(async () => {
      const text = await window.webContents.executeJavaScript(
        "document.querySelector('#tasks')?.textContent"
      ) as string;
      return text.includes("UI fixture task") ? text : undefined;
    });
    const reset = await window.webContents.executeJavaScript(`
      ({
        title: document.querySelector('[name=title]').value,
        criterion: document.querySelector('[name=criterion]').value
      })
    `) as { title: string; criterion: string };
    assert.deepEqual(reset, { title: "", criterion: "" });

    await window.webContents.executeJavaScript(`
      const button = document.querySelector('#tasks button');
      button.click();
      button.click();
    `);
    const runResult = await waitFor(async () => {
      const text = await window.webContents.executeJavaScript(
        "document.querySelector('#run-result')?.textContent"
      ) as string;
      return text.includes("accepted: false") ? text : undefined;
    });
    assert.match(runResult, /Independent review is unavailable/);
    await waitFor(async () => {
      const text = await window.webContents.executeJavaScript(
        "document.querySelector('#tasks')?.textContent"
      ) as string;
      return text.includes("attempt succeeded") ? text : undefined;
    });
    const runCount = await window.webContents.executeJavaScript(`
      window.orchestrator.listTasks().then(async (tasks) =>
        (await window.orchestrator.listRuns(tasks.value[0].id)).value.length)
    `) as number;
    assert.equal(runCount, 1);

    const higherRisk = await window.webContents.executeJavaScript(`
      Promise.all([2, 3].map((riskTier) => window.orchestrator.createTask({
        title: 'Tier ' + riskTier,
        description: 'Higher-risk task',
        acceptanceCriteria: ['approval'],
        riskTier
      })))
    `) as Array<{ ok: boolean; value?: { id: string } }>;
    assert.equal(higherRisk.every((result) => result.ok), true);
    for (const result of higherRisk) {
      const before = await window.webContents.executeJavaScript(
        `window.orchestrator.listRuns('${result.value?.id}')`
      ) as { ok: boolean; value?: readonly unknown[] };
      const rejected = await window.webContents.executeJavaScript(
        `window.orchestrator.runFixture('${result.value?.id}')`
      ) as { ok: boolean; error?: { code: string } };
      const after = await window.webContents.executeJavaScript(
        `window.orchestrator.listRuns('${result.value?.id}')`
      ) as { ok: boolean; value?: readonly unknown[] };
      assert.deepEqual(rejected, {
        ok: false,
        error: {
          code: "APPROVAL_REQUIRED",
          message: "Fixture runner supports risk-tier 1 tasks only"
        }
      });
      assert.equal(before.value?.length, 0);
      assert.equal(after.value?.length, 0);
    }
  } catch (error) {
    throw error;
  } finally {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.destroy();
    }
  }
});
