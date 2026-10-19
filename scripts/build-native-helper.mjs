import { existsSync, mkdirSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";

mkdirSync("dist-native", { recursive: true });
const source = "native\\job-object-helper\\job_object_helper.cpp";
const output = "dist-native\\job-object-helper.exe";

try {
  const argumentsLine = `/nologo /std:c++20 /W4 /EHsc ${source} /Fo:dist-native\\job_object_helper.obj /Fe:${output} /link /subsystem:console`;
  const vcvars = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat";
  if (process.platform !== "win32" || !existsSync(vcvars)) {
    execFileSync("cl", argumentsLine.split(" "), { stdio: "inherit", windowsHide: true });
  } else {
    execSync(`call "${vcvars}" >nul && cl ${argumentsLine}`, {
      stdio: "inherit",
      windowsHide: true
    });
  }
} catch (error) {
  console.error("Native helper build failed. Run from an x64 Native Tools command shell.", error);
  process.exitCode = 1;
}
