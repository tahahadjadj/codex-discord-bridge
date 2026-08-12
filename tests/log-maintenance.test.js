"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { trimBridgeLogs, trimLogFile } = require("../src/log-maintenance");

describe("log maintenance", () => {
  test("keeps the newest bytes when a log exceeds its limit", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-logs-"));
    const logPath = path.join(logDir, "bridge.err.log");
    try {
      await fs.writeFile(logPath, "0123456789");

      await expect(trimLogFile(logPath, 4)).resolves.toBe(true);
      await expect(fs.readFile(logPath, "utf8")).resolves.toBe("6789");
    } finally {
      await fs.rm(logDir, { recursive: true, force: true });
    }
  });

  test("leaves small and missing logs unchanged", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-logs-"));
    const outputPath = path.join(logDir, "bridge.out.log");
    try {
      await fs.writeFile(outputPath, "ok");

      await expect(trimBridgeLogs(logDir, 10)).resolves.toBe(false);
      await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("ok");
    } finally {
      await fs.rm(logDir, { recursive: true, force: true });
    }
  });
});
