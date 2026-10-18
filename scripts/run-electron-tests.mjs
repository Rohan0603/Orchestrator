import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

const [expectedArgument, testFile] = process.argv.slice(2);
const expected = Number(expectedArgument?.replace("--expected=", ""));
if (!Number.isInteger(expected) || expected < 1 || !testFile) {
  console.error("Usage: node scripts/run-electron-tests.mjs --expected=N test-file");
  process.exit(2);
}

const electron = path.resolve("node_modules/electron/dist/electron.exe");
const child = spawn(electron, ["--no-sandbox", "--test", testFile], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let output = "";
let resultCount = 0;
let finished = false;
let pending = "";
let timeout;

function cleanup() {
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$root=${child.pid}; $ids=New-Object System.Collections.Generic.List[int]; $queue=New-Object System.Collections.Generic.Queue[int]; $queue.Enqueue($root); while($queue.Count -gt 0){$id=$queue.Dequeue(); $ids.Add($id); $children=Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId; foreach($childId in @($children)){$queue.Enqueue([int]$childId)}}; foreach($id in ($ids | Sort-Object -Descending)){if(Get-Process -Id $id -ErrorAction SilentlyContinue){Stop-Process -Id $id -Force -ErrorAction SilentlyContinue}}; exit 0`
      ],
      { stdio: "ignore" }
    );
    return true;
  } catch {
    process.stderr.write("Electron test cleanup failed\n");
    return false;
  }
}

function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  process.exitCode = cleanup() ? code : 1;
}

function consume(chunk) {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
  pending += text;
  const lines = pending.split(/\r?\n/);
  pending = lines.pop() ?? "";
  resultCount += lines.filter((line) => /^\s*(?:✔|✖)\s/.test(line)).length;
  if (resultCount >= expected) {
    setTimeout(() => finish(/[✖]|not ok|Unhandled|ERR_[A-Z_]+/.test(output) ? 1 : 0), 250);
  }
}

child.stdout.on("data", consume);
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
  process.stderr.write(chunk);
});
child.on("error", () => finish(1));
child.on("close", (code) => {
  if (/^\s*(?:✔|✖)\s/.test(pending)) resultCount += 1;
  if (!finished) finish(code === 0 && resultCount === expected ? 0 : 1);
});
timeout = setTimeout(() => {
  process.stderr.write(`Electron test timeout after ${expected} results\n`);
  finish(1);
}, 120_000);
