# Knowledge Base

## Codex Discord Bridge

This project runs a local Node.js process that connects a Discord bot to the
local `codex app-server` JSON-RPC interface.

## Runtime Flow

1. `src/index.js` loads `.env`, validates required settings, starts Codex
   app-server, and logs the Discord bot in.
2. `src/discord-bridge.js` ensures a `Codex Sessions` category and
   `codex-control` channel exist in the configured Discord server.
3. The bridge creates project-specific Discord categories named
   `Codex - <project-folder>` from each thread's `cwd`.
4. The bridge polls `thread/list` for recently active, non-archived local Codex
   threads and creates a Discord channel for each thread that is not already
   mapped in `data/session-map.json`.
5. A message like `!codex new fix login` in the control channel starts a Codex
   thread and creates a matching Discord text channel.
6. Messages in the mirrored session channel resume the stored thread, then call
   `turn/start` when idle or `turn/steer` when a Codex turn is already active.
   Supported Discord image attachments are downloaded to `data/attachments` and
   forwarded to Codex as `localImage` input items alongside the text.
7. Discord-originated Codex turns stream agent-message deltas back into the
   session channel on a short timer. The timer is controlled by
   `DISCORD_STREAM_FLUSH_INTERVAL_MS` and defaults to `1500`.
8. Completed agent messages are still used as a fallback when no live delta was
   received, but already streamed text is not posted a second time.
9. `turn/completed` clears the active turn, flushes pending output, posts an
   end-of-turn ping, updates the channel topic, and posts extra status context
   when no assistant output was recorded or the turn did not complete normally.
10. `src/codex-app-server.js` enforces a request timeout for JSON-RPC calls. If
    Codex app-server stops responding, the bridge tears down that process,
    rejects the stuck request, and recreates a fresh app-server connection on
    the next request instead of hanging Discord message handling indefinitely.
11. When a mapped Codex thread cannot be resumed, `src/discord-bridge.js`
    creates a replacement local thread, remaps the existing Discord channel to
    it, renames the channel to match the new thread id suffix, and posts a
    recovery notice in-channel before continuing with future Discord messages.

## Active Session Discovery

The bridge treats active sessions as non-archived Codex threads updated within
`CODEX_ACTIVE_SESSION_MAX_AGE_HOURS` and caps discovery at
`CODEX_SESSION_SYNC_LIMIT`. It intentionally does not post historical prompt
content when a channel is first created. It seeds `lastSeenTurnId` from existing
turn history and only posts future completed turns.

Active-session discovery is polling-based. Sessions started outside this bridge
are posted after their turns complete because the bridge is not subscribed to the
separate live app-server process that owns those turns.

Codex can surface what looks like the same session with a different internal
thread id, especially for repeated local app/worktree sessions that share the
same title and project. Before creating a new Discord channel, discovery now
looks for an existing inactive mirror with the same stable session identity:
project folder name plus thread title. If one exists, the bridge remaps that
channel to the new thread id instead of creating another channel. Historical
content is not backfilled during this remap.

The active-session poller uses the lightweight `thread/list` summary before it
loads full turn history. If the summary `updatedAt` value has not advanced since
the session's stored `lastSeenThreadUpdatedAt`, the poller skips `thread/read`.
If the summary was updated recently, the poller waits for
`CODEX_THREAD_SYNC_QUIET_MS` before reading full history so large active threads
are not repeatedly parsed while Codex is still writing. Failed thread syncs are
backed off for `CODEX_THREAD_SYNC_BACKOFF_MS` to avoid retry loops after app
server timeouts.

For Discord-originated turns, the live app-server event stream is the source of
truth for posting output. When a live turn completes, the bridge advances the
thread update cursor. If the poller later sees that same completed
Discord-interacted session, it advances the summary cursor without reading full
history, avoiding expensive backfill reads for large threads whose output was
already streamed.

When the poller sees any `inProgress` turn after the session's last synced turn,
it marks the channel as running and defers all later terminal-turn posts and
completion pings until the in-progress turn has settled. This prevents a ping
for an earlier completed turn while the same Codex thread is still working.

Completion pings use the Discord user who last sent a message in that mirrored
session. For sessions discovered from local Codex with no Discord sender yet,
set comma-separated `DISCORD_NOTIFY_USER_IDS` to users who should be mentioned
when a terminal turn is synced. The ping is debounced by
`DISCORD_COMPLETION_PING_QUIET_MS`, which defaults to `10000`; every streamed
delta, posted chunk, status message, or new turn resets the timer so the mention
only fires after the thread has been quiet for 10 seconds.

Interrupted turns can be written by Codex before their history is fully settled.
For interrupted turns with no `completedAt`, the poller waits
`CODEX_INTERRUPTED_TURN_GRACE_MS` from the thread's last update before posting.
This prevents the bridge from advancing `lastSeenTurnId` before partial assistant
messages appear in `thread/read`.

Session channels are grouped by project folder so Discord users can identify the
owning project without opening the channel topic. Existing mapped channels are
moved to the expected project category when their thread appears in active
session discovery.

Mirrored channels and project categories are ordered by recent activity. On
startup, the bridge reads each channel's Discord `lastMessageId`, falls back to
the stored Codex session timestamp when needed, sorts channels newest-first
inside each category, and sorts project categories by their newest channel.
Whenever a user or bot message appears in a mirrored channel, the bridge moves
that channel to the top of its category and moves the category to the top of the
server. Position updates use a leading-edge cooldown controlled by
`DISCORD_CHANNEL_REORDER_DEBOUNCE_MS`, which defaults to `2000`, so streamed
responses do not create a Discord API request for every message fragment.

Discord has a practical server channel ceiling, so the bridge bounds mirrored
session channels before creating new ones. `DISCORD_MAX_MIRRORED_SESSION_CHANNELS`
defaults to `75`, `DISCORD_MAX_GUILD_CHANNELS` defaults to `450`, and
`DISCORD_CHANNEL_PRUNE_MIN_AGE_HOURS` defaults to `24`. If creating a new mirror
would exceed either limit, the bridge prefers deleting the oldest inactive mirror
in the same project category first, then falls back to the oldest inactive mirror
in any category if that project has nothing old enough to prune. The deleted
channel is also removed from `data/session-map.json`. Active turns and the
thread currently being mirrored are never pruned.

External-update verification was performed by resuming an already mirrored Codex
thread from a separate app-server client, completing a new turn, and confirming
the bridge posted the new agent message to that thread's Discord channel.

## Codex Notify Flow

`src/notify-discord.js` is a standalone target for Codex `notify`. Codex can be
configured with:

```toml
notify = ["node", "/absolute/path/to/codex-discord-bridge/src/notify-discord.js"]
```

The script reads the JSON payload from stdin or argv, formats a short Discord
message, and sends it to `DISCORD_NOTIFY_CHANNEL_ID`. If no notify channel ID is
configured, it resolves the channel named by `DISCORD_CONTROL_CHANNEL_NAME` in
`DISCORD_GUILD_ID`.

## Local State

The channel-to-thread mapping is stored in `data/session-map.json`. The file is
ignored by Git because it is machine/server specific.

Do not overwrite the runtime `data/session-map.json` during deploys. It contains
the live `lastSeenTurnId` cursors used to prevent replaying old Codex output
after restart. Use `scripts/deploy-runtime.sh`, which excludes the runtime state
file while syncing source changes into the LaunchAgent app directory.

Downloaded Discord image attachments are stored under `data/attachments`. The
folder is ignored by Git and is intentionally retained so Codex thread history
can still resolve local image paths after the turn starts. Attachment limits are
controlled by `DISCORD_IMAGE_ATTACHMENT_MAX_COUNT` and
`DISCORD_IMAGE_ATTACHMENT_MAX_BYTES`.

App-server request timeouts are controlled by `CODEX_REQUEST_TIMEOUT_MS`.

## Deployment

The bridge is deployed locally as the user LaunchAgent
`~/Library/LaunchAgents/com.local.codex-discord-bridge.plist`.

The LaunchAgent has `RunAtLoad` and `KeepAlive` enabled so it starts when the
macOS user session starts and restarts if the bridge exits.

The LaunchAgent runs from a runtime copy outside `~/Documents` because macOS
privacy controls can block background jobs from spawning executables or using a
working directory inside protected Documents paths:

```text
~/Library/Application Support/CodexDiscordBridge/app
```

The LaunchAgent runs:

```bash
~/Library/Application Support/CodexDiscordBridge/app/scripts/launch-bridge.sh
```

Runtime logs are stored in `logs/bridge.out.log` and `logs/bridge.err.log`.

Use `scripts/install-launch-agent.sh` for first-time installation. It generates
the LaunchAgent with the current Node executable, deploys the runtime, and
starts the service. The launch scripts also resolve Node from `PATH` or the
optional `NODE_BIN` variable, so they work with Homebrew and other Node
installations.

Use `scripts/deploy-runtime.sh` for later local deploys. It syncs source files into
the Application Support runtime copy, preserves `data/session-map.json`,
preserves downloaded attachments and logs, and restarts the LaunchAgent.

## Required Discord Permissions

- View Channels
- Send Messages
- Read Message History
- Manage Channels

The bot also needs the Discord message content intent unless the bridge is
converted to slash commands.

## Secret Handling

The Discord token belongs in `.env`. Source files and documentation use
placeholders only. Public installations should set `OWNER_DISCORD_USER_IDS` and
start with `CODEX_SANDBOX=workspace-write` plus
`CODEX_APPROVAL_POLICY=on-request`.

## Model Pinning

The local bridge defaults Discord-originated work to `CODEX_MODEL=gpt-5.5` and
`CODEX_REASONING_EFFORT=xhigh`. This keeps messages sent from Discord on the
latest high-capability Codex model with extra-high reasoning unless the runtime
environment explicitly overrides it.

Discord-originated user messages pass the pinned model and reasoning effort on
`thread/start`, `thread/resume`, replacement thread creation, and `turn/start`.
This prevents older mapped threads from continuing with stale model metadata
inherited from their original session.

If the local Codex account cannot access the default model, set `CODEX_MODEL` in
the runtime `.env` to the best available model. `CODEX_REASONING_EFFORT` accepts
`low`, `medium`, `high`, `xhigh`, and aliases like `extra high`.

The public example uses `CODEX_SANDBOX=workspace-write` and
`CODEX_APPROVAL_POLICY=on-request`. A private installation may explicitly use
`danger-full-access` and `never` for unattended operation, but this grants
accepted Discord messages full local authority. Keep Discord authorization
restricted with `OWNER_DISCORD_USER_IDS` and review `SECURITY.md` before making
that change.

The public repository runs tests and ESLint through `.github/workflows/ci.yml`.
Dependabot checks npm and GitHub Actions dependencies weekly. Public bug and
support reports require contributors to confirm that credentials and private
data were removed.

The active-session poller avoids Discord metadata edits in the hot path. Channel
parent/category maintenance is kept separate from update delivery so rate limits
or slow channel edits do not block Codex message posting.

The live event path and polling path both suppress the bare
`Codex turn completed.` marker when assistant output has already been sent. This
keeps the latest visible bot message as the actual Codex response instead of a
completion footer.

Non-completed status messages include context. For interrupted turns, Discord
gets a prompt preview, whether partial output was posted, and the stored Codex
error when one exists.
