"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const LOG_FILENAMES = ["bridge.out.log", "bridge.err.log"];

async function trimLogFile(filePath, maxBytes) {
  let handle;

  try {
    handle = await fs.open(filePath, "r+");
    const stats = await handle.stat();
    if (stats.size <= maxBytes) {
      return false;
    }

    const retained = Buffer.alloc(maxBytes);
    await handle.read(retained, 0, retained.length, stats.size - retained.length);
    await handle.truncate(0);
    await handle.write(retained, 0, retained.length, 0);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function trimBridgeLogs(logDir, maxBytes) {
  const results = await Promise.all(
    LOG_FILENAMES.map((filename) => trimLogFile(path.join(logDir, filename), maxBytes))
  );
  return results.some(Boolean);
}

async function startLogMaintenance(config) {
  const trim = async () => {
    try {
      await trimBridgeLogs(config.bridgeLogDir, config.bridgeLogMaxBytes);
    } catch (error) {
      console.error(`Could not trim bridge logs: ${error.message}`);
    }
  };

  await trim();
  const timer = setInterval(trim, config.bridgeLogTrimIntervalMs);
  timer.unref();
  return timer;
}

module.exports = {
  startLogMaintenance,
  trimBridgeLogs,
  trimLogFile
};
