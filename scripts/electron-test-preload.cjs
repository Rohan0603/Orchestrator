const { after } = require("node:test");
const { app } = require("electron");

after(() => app.quit());
