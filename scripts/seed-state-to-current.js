"use strict";

require("dotenv").config();

const { CodexAppServer } = require("../src/codex-app-server");
const { loadConfig, validateConfig } = require("../src/config");
const { StateStore } = require("../src/state-store");
const { seedLastSeenTurnId } = require("../src/thread-sync");

async function main() {
  const config = loadConfig();
  validateConfig(config);

  const codex = new CodexAppServer({
    command: config.codexCommand,
    requestTimeoutMs: config.codexRequestTimeoutMs
  });
  const store = new StateStore(config.statePath);

  await store.load();
  await codex.initialize();

  try {
    for (const session of store.listSessions()) {
      try {
        const thread = await codex.readThread(session.threadId, true);
        const lastSeenTurnId = seedLastSeenTurnId(thread.turns || []);
        if (!lastSeenTurnId) {
          continue;
        }

        await store.updateSessionByThread(session.threadId, {
          lastSeenTurnId,
          lastSeenThreadUpdatedAt: thread.updatedAt,
          lastSeenTurnStatus: (thread.turns || []).find((turn) => turn.id === lastSeenTurnId)?.status || null
        });
        console.log(`Seeded ${session.threadId} at ${lastSeenTurnId}`);
      } catch (error) {
        console.error(`Could not seed ${session.threadId}: ${error.message}`);
      }
    }
  } finally {
    codex.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
