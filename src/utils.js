"use strict";

const DISCORD_MESSAGE_LIMIT = 2000;

function slugifyChannelName(input, fallback = "codex-session") {
  const base = String(input || "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return base || fallback;
}

function chunkDiscordMessage(text, limit = DISCORD_MESSAGE_LIMIT) {
  const normalized = String(text || "");

  if (normalized.length <= limit) {
    return normalized ? [normalized] : [];
  }

  const chunks = [];
  let remaining = normalized;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function truncateForTopic(text, limit = 1024) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) {
    return clean;
  }

  return `${clean.slice(0, limit - 3)}...`;
}

function parseControlCommand(content) {
  const text = String(content || "").trim();
  if (!text.startsWith("!codex")) {
    return null;
  }

  const args = text.slice("!codex".length).trim();
  if (!args) {
    return { command: "help", title: "" };
  }

  const [command, ...rest] = args.split(/\s+/);
  return {
    command: command.toLowerCase(),
    title: rest.join(" ").trim()
  };
}

module.exports = {
  DISCORD_MESSAGE_LIMIT,
  chunkDiscordMessage,
  parseControlCommand,
  slugifyChannelName,
  truncateForTopic
};
