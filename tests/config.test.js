"use strict";

const {
  loadConfig,
  normalizeReasoningEffort,
  normalizeSandboxMode,
  parseBoolean,
  parsePositiveNumber,
  splitCsv,
  validateConfig
} = require("../src/config");

describe("config", () => {
  test("splits comma-separated owner IDs", () => {
    expect(splitCsv("1, 2,,3")).toEqual(["1", "2", "3"]);
  });

  test("loads required Discord settings", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      DISCORD_GUILD_ID: "guild",
      CODEX_CWD: "."
    });

    expect(config.discordToken).toBe("token");
    expect(config.guildId).toBe("guild");
    expect(config.notifyUserIds).toEqual([]);
    expect(config.codexModel).toBe("gpt-5.5");
    expect(config.codexReasoningEffort).toBe("xhigh");
    expect(config.codexRequestTimeoutMs).toBe(45000);
    expect(config.streamFlushIntervalMs).toBe(1500);
    expect(config.interruptedTurnGraceMs).toBe(120000);
    expect(config.threadSyncQuietMs).toBe(60000);
    expect(config.threadSyncBackoffMs).toBe(300000);
    expect(config.completionPingQuietMs).toBe(10000);
    expect(config.channelReorderDebounceMs).toBe(2000);
    expect(config.logAppServerStderr).toBe(false);
    expect(config.bridgeLogDir).toContain("logs");
    expect(config.bridgeLogMaxBytes).toBe(10 * 1024 * 1024);
    expect(config.bridgeLogCheckIntervalMs).toBe(60 * 60 * 1000);
    expect(config.maxMirroredSessionChannels).toBe(75);
    expect(config.maxGuildChannels).toBe(450);
    expect(config.channelPruneMinAgeHours).toBe(24);
    expect(config.attachmentDir).toContain("data");
    expect(config.maxImageAttachments).toBe(4);
    expect(config.maxImageAttachmentBytes).toBe(10 * 1024 * 1024);
  });

  test("normalizes app-server sandbox values", () => {
    expect(normalizeSandboxMode("workspaceWrite")).toBe("workspace-write");
    expect(normalizeSandboxMode("dangerFullAccess")).toBe("danger-full-access");
    expect(normalizeSandboxMode("workspace-write")).toBe("workspace-write");
  });

  test("normalizes Codex reasoning effort values", () => {
    expect(normalizeReasoningEffort()).toBe("xhigh");
    expect(normalizeReasoningEffort("extra high")).toBe("xhigh");
    expect(normalizeReasoningEffort("extra-high")).toBe("xhigh");
    expect(normalizeReasoningEffort("x_high")).toBe("xhigh");
    expect(normalizeReasoningEffort("high")).toBe("high");
    expect(normalizeReasoningEffort("unexpected")).toBe("xhigh");
  });

  test("parses boolean and positive number settings", () => {
    expect(parseBoolean("true")).toBe(true);
    expect(parseBoolean("0", true)).toBe(false);
    expect(parsePositiveNumber("15", 5)).toBe(15);
    expect(parsePositiveNumber("-1", 5)).toBe(5);
  });

  test("loads custom stream flush interval", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      DISCORD_GUILD_ID: "guild",
      DISCORD_NOTIFY_USER_IDS: "user-1, user-2",
      CODEX_REQUEST_TIMEOUT_MS: "15000",
      DISCORD_MAX_MIRRORED_SESSION_CHANNELS: "10",
      DISCORD_MAX_GUILD_CHANNELS: "400",
      DISCORD_CHANNEL_PRUNE_MIN_AGE_HOURS: "2",
      CODEX_MODEL: "gpt-5.4",
      CODEX_REASONING_EFFORT: "extra high",
      DISCORD_STREAM_FLUSH_INTERVAL_MS: "2500",
      CODEX_INTERRUPTED_TURN_GRACE_MS: "45000",
      CODEX_THREAD_SYNC_QUIET_MS: "15000",
      CODEX_THREAD_SYNC_BACKOFF_MS: "90000",
      DISCORD_COMPLETION_PING_QUIET_MS: "12000",
      DISCORD_CHANNEL_REORDER_DEBOUNCE_MS: "3500",
      CODEX_LOG_APP_SERVER_STDERR: "true",
      BRIDGE_LOG_DIR: "/tmp/bridge-logs",
      BRIDGE_LOG_MAX_BYTES: "2048",
      BRIDGE_LOG_CHECK_INTERVAL_MS: "5000",
      DISCORD_ATTACHMENT_DIR: "/tmp/discord-images",
      DISCORD_IMAGE_ATTACHMENT_MAX_COUNT: "2",
      DISCORD_IMAGE_ATTACHMENT_MAX_BYTES: "1024"
    });

    expect(config.notifyUserIds).toEqual(["user-1", "user-2"]);
    expect(config.codexModel).toBe("gpt-5.4");
    expect(config.codexReasoningEffort).toBe("xhigh");
    expect(config.maxMirroredSessionChannels).toBe(10);
    expect(config.maxGuildChannels).toBe(400);
    expect(config.channelPruneMinAgeHours).toBe(2);
    expect(config.codexRequestTimeoutMs).toBe(15000);
    expect(config.streamFlushIntervalMs).toBe(2500);
    expect(config.interruptedTurnGraceMs).toBe(45000);
    expect(config.threadSyncQuietMs).toBe(15000);
    expect(config.threadSyncBackoffMs).toBe(90000);
    expect(config.completionPingQuietMs).toBe(12000);
    expect(config.channelReorderDebounceMs).toBe(3500);
    expect(config.logAppServerStderr).toBe(true);
    expect(config.bridgeLogDir).toBe("/tmp/bridge-logs");
    expect(config.bridgeLogMaxBytes).toBe(2048);
    expect(config.bridgeLogCheckIntervalMs).toBe(5000);
    expect(config.attachmentDir).toBe("/tmp/discord-images");
    expect(config.maxImageAttachments).toBe(2);
    expect(config.maxImageAttachmentBytes).toBe(1024);
  });

  test("validates missing settings", () => {
    expect(() => validateConfig(loadConfig({}))).toThrow("DISCORD_TOKEN");
  });
});
