"use strict";

const path = require("node:path");

function splitCsv(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeSandboxMode(value) {
  if (value === "workspaceWrite") {
    return "workspace-write";
  }
  if (value === "readOnly") {
    return "read-only";
  }
  if (value === "dangerFullAccess") {
    return "danger-full-access";
  }

  return value || "workspace-write";
}

function normalizeReasoningEffort(value) {
  if (value === undefined || value === null || value === "") {
    return "xhigh";
  }

  const normalized = String(value).trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "extrahigh" || normalized === "xhigh") {
    return "xhigh";
  }
  if (["low", "medium", "high"].includes(normalized)) {
    return normalized;
  }

  return "xhigh";
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parsePositiveNumber(value, defaultValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function loadConfig(env = process.env) {
  const cwd = env.CODEX_CWD && env.CODEX_CWD.trim()
    ? path.resolve(env.CODEX_CWD)
    : process.cwd();

  return {
    discordToken: env.DISCORD_TOKEN,
    guildId: env.DISCORD_GUILD_ID,
    ownerUserIds: splitCsv(env.OWNER_DISCORD_USER_IDS),
    notifyUserIds: splitCsv(env.DISCORD_NOTIFY_USER_IDS),
    codexCommand: env.CODEX_COMMAND || "codex",
    codexModel: env.CODEX_MODEL || "gpt-5.5",
    codexReasoningEffort: normalizeReasoningEffort(
      env.CODEX_REASONING_EFFORT || env.CODEX_MODEL_REASONING_EFFORT
    ),
    codexCwd: cwd,
    codexSandbox: normalizeSandboxMode(env.CODEX_SANDBOX),
    codexApprovalPolicy: env.CODEX_APPROVAL_POLICY || "on-request",
    categoryName: env.DISCORD_CATEGORY_NAME || "Codex Sessions",
    controlChannelName: env.DISCORD_CONTROL_CHANNEL_NAME || "codex-control",
    discoverActiveSessions: parseBoolean(env.CODEX_DISCOVER_ACTIVE_SESSIONS, true),
    activeSessionMaxAgeHours: parsePositiveNumber(env.CODEX_ACTIVE_SESSION_MAX_AGE_HOURS, 6),
    sessionSyncIntervalMs: parsePositiveNumber(env.CODEX_SESSION_SYNC_INTERVAL_MS, 30000),
    sessionSyncLimit: parsePositiveNumber(env.CODEX_SESSION_SYNC_LIMIT, 25),
    threadSyncQuietMs: parsePositiveNumber(env.CODEX_THREAD_SYNC_QUIET_MS, 60000),
    threadSyncBackoffMs: parsePositiveNumber(env.CODEX_THREAD_SYNC_BACKOFF_MS, 300000),
    maxMirroredSessionChannels: parsePositiveNumber(env.DISCORD_MAX_MIRRORED_SESSION_CHANNELS, 75),
    maxGuildChannels: parsePositiveNumber(env.DISCORD_MAX_GUILD_CHANNELS, 450),
    channelPruneMinAgeHours: parsePositiveNumber(env.DISCORD_CHANNEL_PRUNE_MIN_AGE_HOURS, 24),
    codexRequestTimeoutMs: parsePositiveNumber(env.CODEX_REQUEST_TIMEOUT_MS, 45000),
    streamFlushIntervalMs: parsePositiveNumber(env.DISCORD_STREAM_FLUSH_INTERVAL_MS, 1500),
    interruptedTurnGraceMs: parsePositiveNumber(env.CODEX_INTERRUPTED_TURN_GRACE_MS, 120000),
    completionPingQuietMs: parsePositiveNumber(env.DISCORD_COMPLETION_PING_QUIET_MS, 10000),
    channelReorderDebounceMs: parsePositiveNumber(env.DISCORD_CHANNEL_REORDER_DEBOUNCE_MS, 2000),
    attachmentDir: env.DISCORD_ATTACHMENT_DIR || path.join(process.cwd(), "data", "attachments"),
    maxImageAttachments: parsePositiveNumber(env.DISCORD_IMAGE_ATTACHMENT_MAX_COUNT, 4),
    maxImageAttachmentBytes: parsePositiveNumber(env.DISCORD_IMAGE_ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024),
    statePath: env.STATE_PATH || path.join(process.cwd(), "data", "session-map.json")
  };
}

function validateConfig(config) {
  const missing = [];

  if (!config.discordToken) {
    missing.push("DISCORD_TOKEN");
  }

  if (!config.guildId) {
    missing.push("DISCORD_GUILD_ID");
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

module.exports = {
  loadConfig,
  normalizeReasoningEffort,
  normalizeSandboxMode,
  parseBoolean,
  parsePositiveNumber,
  splitCsv,
  validateConfig
};
