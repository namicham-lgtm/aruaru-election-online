"use strict";
/* サーバ起動 → E2E実行 → 終了 を1コマンドで行うランナー */
const { spawn } = require("child_process");
const path = require("path");

const server = spawn("node", [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: "3100" },
  stdio: "ignore",
});
setTimeout(() => {
  const test = spawn("node", [path.join(__dirname, "e2e.test.js")], { stdio: "inherit" });
  test.on("exit", (code) => {
    server.kill();
    process.exit(code);
  });
}, 1000);
