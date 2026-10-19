import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { app, BrowserWindow } from "electron";
import Database from "better-sqlite3";

const directory = mkdtempSync(join(tmpdir(), "orchestrator-owned-ipc-"));
writeFileSync(join(directory, "fixture.html"), "<!doctype html><html><body>owned</body></html>");
app.setPath("userData", join(directory, "user-data"));
process.env.ORCHESTRATOR_RENDERER_PATH = join(directory, "fixture.html");

test("Electron main runs owned fixture through helper and persists cleanup", async () => {
  try {
    await import("../src/main/main");
    await app.whenReady();
    const window = BrowserWindow.getAllWindows()[0];
    assert.ok(window, "main window was not created");
    await new Promise<void>((resolve) => {
      if (window.webContents.isLoading()) window.webContents.once("did-finish-load", () => resolve());
      else resolve();
    });
    const created = await window.webContents.executeJavaScript(
      `window.orchestrator.createTask({
        title: "Owned fixture",
        description: "Run through main-process ownership",
        acceptanceCriteria: ["cleanup"],
        riskTier: 1
      })`
    ) as { ok: boolean; value?: { id: string } };
    assert.equal(created.ok, true);
    const result = await window.webContents.executeJavaScript(
      `window.orchestrator.runOwnedFixture(${JSON.stringify(created.value?.id)})`
    ) as { ok: boolean; value?: { ownershipVerified: boolean; cleanupVerified: boolean; activeProcessesAfterCleanup: number } };
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value?.ownershipVerified, true);
    assert.equal(result.value?.cleanupVerified, true);
    assert.equal(result.value?.activeProcessesAfterCleanup, 0);
    const database = new Database(join(directory, "user-data", "orchestrator.db"), { readonly: true });
    try {
      assert.deepEqual(
        database.prepare("SELECT state FROM runs").get(),
        { state: "verification" }
      );
      assert.deepEqual(
        database.prepare("SELECT state, cleanup_verified FROM ownership_records").get(),
        { state: "cleanup_verified", cleanup_verified: 1 }
      );
    } finally {
      database.close();
    }
  } finally {
    for (const current of BrowserWindow.getAllWindows()) {
      if (!current.isDestroyed()) current.destroy();
    }
    setTimeout(() => {
      app.quit();
      rmSync(directory, { recursive: true, force: true });
    }, 50);
  }
});
