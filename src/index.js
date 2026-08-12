"use strict";

require("dotenv").config({ quiet: true });

const { CodexAppServer } = require("./codex-app-server");
const { loadConfig, validateConfig } = require("./config");
const { DiscordCodexBridge } = require("./discord-bridge");
const { startLogMaintenance } = require("./log-maintenance");
const { StateStore } = require("./state-store");

async function main() {
  const config = loadConfig();
  validateConfig(config);
  await startLogMaintenance(config);

  const codex = new CodexAppServer({
    command: config.codexCommand,
    requestTimeoutMs: config.codexRequestTimeoutMs
  });
  const stateStore = new StateStore(config.statePath);
  const bridge = new DiscordCodexBridge({ config, codex, stateStore });

  process.on("SIGINT", () => {
    codex.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    codex.stop();
    process.exit(0);
  });

  await bridge.start();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
