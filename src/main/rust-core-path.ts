import path from "node:path";
import { existsSync } from "node:fs";

export function resolveRustCoreExecutablePath(options: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
  readonly platform: string;
}): string {
  const executable = options.platform === "win32" ? "orchestrator-core.exe" : "orchestrator-core";
  if (options.isPackaged) return path.join(options.resourcesPath, executable);
  const appRoot = existsSync(path.join(options.appPath, "Cargo.toml"))
    ? options.appPath
    : process.cwd();
  return path.join(appRoot, "target", "debug", executable);
}
