"use strict";

require("dotenv").config();

const { chunkDiscordMessage } = require("./utils");
const { formatNotifyMessage } = require("./notify-message");

const DISCORD_API_BASE = "https://discord.com/api/v10";

async function readPayload() {
  const chunks = [];

  if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim() || process.argv.slice(2).join(" ").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw, event: "codex-notify" };
  }
}

async function discordRequest(path, options = {}) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("DISCORD_TOKEN is required");
  }

  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...options.headers
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord API ${response.status}: ${body}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function resolveChannelId() {
  if (process.env.DISCORD_NOTIFY_CHANNEL_ID) {
    return process.env.DISCORD_NOTIFY_CHANNEL_ID;
  }

  const guildId = process.env.DISCORD_GUILD_ID;
  const channelName = process.env.DISCORD_CONTROL_CHANNEL_NAME || "codex-control";
  if (!guildId) {
    throw new Error("DISCORD_GUILD_ID is required when DISCORD_NOTIFY_CHANNEL_ID is not set");
  }

  const channels = await discordRequest(`/guilds/${guildId}/channels`);
  const channel = channels.find((item) => item.name === channelName);
  if (!channel) {
    throw new Error(`Could not find Discord channel named ${channelName}`);
  }

  return channel.id;
}

async function sendMessage(channelId, content) {
  for (const chunk of chunkDiscordMessage(content, 1900)) {
    await discordRequest(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: chunk })
    });
  }
}

async function main() {
  const payload = await readPayload();
  const channelId = await resolveChannelId();
  await sendMessage(channelId, formatNotifyMessage(payload));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  readPayload,
  resolveChannelId,
  sendMessage
};
