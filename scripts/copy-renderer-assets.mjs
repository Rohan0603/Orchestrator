import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const assets = ["index.html", "styles.css"];
for (const asset of assets) {
  const destination = join("dist", "renderer", asset);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join("src", "renderer", asset), destination);
}
