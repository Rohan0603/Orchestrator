import { app } from "electron";
import { runCli } from "./cli";

void runCli(process.argv.slice(2)).then((exitCode) => {
  app.exit(exitCode);
});
