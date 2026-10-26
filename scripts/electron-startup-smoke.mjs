import { app } from "electron";

console.log("smoke: startup");
await app.whenReady();
console.log("smoke: ready");
app.quit();
