# Codex Discord Bridge

A local Node.js bridge that mirrors Codex tasks into Discord channels and sends
Discord messages back to the matching Codex task.

> [!WARNING]
> Discord messages can trigger code execution on the machine running the
> bridge. Read [SECURITY.md](SECURITY.md), restrict `OWNER_DISCORD_USER_IDS`,
> and use the least-permissive Codex sandbox that meets your needs.

## Features

- Creates one Discord category per Codex project and one channel per task.
- Discovers recently active local Codex tasks without replaying old output.
- Sends Discord text and image attachments into the mapped Codex task.
- Streams Codex responses to Discord while the turn is running.
- Mentions the initiating user after completion and a configurable quiet period.
- Reuses channels when Codex exposes a replacement ID for the same task.
- Sorts categories and channels by recent activity.
- Prunes the oldest inactive channels when configured server limits are reached.
- Runs automatically at macOS login through a LaunchAgent.

## Requirements

- macOS for the included LaunchAgent deployment scripts
- Node.js 20 or newer
- A current Codex CLI installation with `codex app-server`
- A Discord bot and server where you can manage channels

The bridge uses the local Codex login. It does not require a separate OpenAI API
key.

## Discord Setup

1. Create an application and bot in the
   [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable **Message Content Intent** under the bot's privileged gateway intents.
3. Invite the bot with **View Channels**, **Send Messages**,
   **Read Message History**, and **Manage Channels** permissions.
4. Copy the server ID and your Discord user ID with Discord Developer Mode.

Never paste the bot token into chat or commit it to Git. Rotate it in the
Developer Portal if it has been exposed.

## Install

```bash
git clone https://github.com/tahahadjadj/codex-discord-bridge.git
cd codex-discord-bridge
npm ci
cp .env.example .env
```

Set at least these values in `.env`:

```dotenv
DISCORD_TOKEN=replace-with-your-bot-token
DISCORD_GUILD_ID=replace-with-your-server-id
OWNER_DISCORD_USER_IDS=replace-with-your-user-id
```

Test interactively:

```bash
npm start
```

The bot creates `codex-control`. Run this command there to create a task:

```text
!codex new investigate the failing tests
```

Messages sent in the resulting task channel are forwarded to Codex. Recently
active tasks created in the Codex app are discovered automatically.

## Start at Login

After interactive testing succeeds, install the macOS LaunchAgent:

```bash
scripts/install-launch-agent.sh
```

It installs the runtime under
`~/Library/Application Support/CodexDiscordBridge/app`, creates
`~/Library/LaunchAgents/com.local.codex-discord-bridge.plist`, starts the bot at
login, and restarts it after an unexpected exit.

Deploy later source changes with:

```bash
scripts/deploy-runtime.sh
```

Useful diagnostics:

```bash
launchctl print "gui/$(id -u)/com.local.codex-discord-bridge"
launchctl kickstart -k "gui/$(id -u)/com.local.codex-discord-bridge"
tail -f "$HOME/Library/Application Support/CodexDiscordBridge/app/logs/bridge.out.log"
```

## Configuration

All settings are documented in [.env.example](.env.example). Important safety
and behavior controls include:

| Variable | Purpose |
| --- | --- |
| `OWNER_DISCORD_USER_IDS` | Comma-separated users allowed to trigger Codex |
| `CODEX_MODEL` | Model selected for Discord-originated turns |
| `CODEX_REASONING_EFFORT` | Reasoning effort, including `xhigh` |
| `CODEX_SANDBOX` | Host access boundary, default `workspace-write` |
| `CODEX_APPROVAL_POLICY` | Approval behavior, default `on-request` |
| `CODEX_ACTIVE_SESSION_MAX_AGE_HOURS` | Active task discovery window |
| `DISCORD_COMPLETION_PING_QUIET_MS` | Quiet time before completion mention |
| `DISCORD_MAX_MIRRORED_SESSION_CHANNELS` | Maximum mirrored task channels |

Approval prompts cannot be completed through this bridge. For unattended
Discord operation, `CODEX_APPROVAL_POLICY=never` avoids stalled turns but
removes that confirmation boundary. Pair it with a restrictive sandbox unless
you intentionally accept full host access.

## Codex Completion Notifications

To notify Discord for local Codex tasks independently of task mirroring, set
Codex's `notify` command in `~/.codex/config.toml`:

```toml
notify = ["node", "/absolute/path/to/codex-discord-bridge/src/notify-discord.js"]
```

Set `DISCORD_NOTIFY_CHANNEL_ID` in `.env`, or let the script use the configured
control channel.

## Development

```bash
npm test
npx eslint .
```

See [docs/architecture.md](docs/architecture.md) for the component model and
[docs/knowledge-base.md](docs/knowledge-base.md) for detailed runtime behavior.
Contribution guidelines are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
