import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { app, BrowserWindow } from "electron";

const directory = mkdtempSync(join(tmpdir(), "orchestrator-ipc-"));
const rendererPath = join(directory, "fixture.html");
writeFileSync(rendererPath, "<!doctype html><html><body>IPC fixture</body></html>");
app.setPath("userData", join(directory, "user-data"));
process.env.ORCHESTRATOR_RENDERER_PATH = rendererPath;
process.once("exit", () => {
  rmSync(directory, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Electron fixture");
}

test("real second WebContents is rejected before task mutation", async () => {
  try {
    await import("../src/main/main");
    await app.whenReady();
    const primary = await waitFor(() => BrowserWindow.getAllWindows()[0]);
    await new Promise<void>((resolve) => {
      if (primary.webContents.isLoading()) {
        primary.webContents.once("did-finish-load", () => resolve());
      } else {
        resolve();
      }
    });

    const created = await primary.webContents.executeJavaScript(
      `window.orchestrator.createTask({
        title: "IPC fixture task",
        description: "Authorized renderer mutation",
        acceptanceCriteria: ["fixture"],
        riskTier: 1
      })`
    ) as { ok: boolean; value?: { id: string } };
    assert.equal(created.ok, true);
    const before = await primary.webContents.executeJavaScript(
      "window.orchestrator.listTasks()"
    ) as { ok: boolean; value?: readonly unknown[] };
    assert.equal(before.ok, true);
    assert.equal(before.value?.length, 1);

    const second = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(process.cwd(), "dist-test", "src", "preload", "preload.js")
      }
    });
    try {
      await second.loadFile(rendererPath);
      const rejected = await second.webContents.executeJavaScript(
        `window.orchestrator.createTask({
          title: "unauthorized",
          description: "must not mutate",
          acceptanceCriteria: ["fixture"],
          riskTier: 1
        })`
      ) as { ok: boolean; error?: { code: string } };
      assert.deepEqual(rejected, {
        ok: false,
        error: { code: "UNTRUSTED_SENDER", message: "IPC sender rejected" }
      });
      const after = await primary.webContents.executeJavaScript(
        "window.orchestrator.listTasks()"
      ) as { ok: boolean; value?: readonly unknown[] };
      assert.equal(after.ok, true);
      assert.equal(after.value?.length, 1);
    } finally {
      if (!second.isDestroyed()) second.destroy();
    }
  } finally {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.destroy();
    }
    setTimeout(() => app.quit(), 50);
  }
});
