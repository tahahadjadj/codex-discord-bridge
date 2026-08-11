#!/bin/zsh
set -euo pipefail

source_dir="${0:A:h:h}"
runtime_dir="${CODEX_DISCORD_RUNTIME_DIR:-$HOME/Library/Application Support/CodexDiscordBridge/app}"

mkdir -p "$runtime_dir/data" "$runtime_dir/logs"

rsync -a --delete \
  --exclude node_modules \
  --exclude logs \
  --exclude data/session-map.json \
  --exclude data/attachments \
  "$source_dir/" "$runtime_dir/"

if [ -d "$source_dir/node_modules" ]; then
  rsync -a --delete "$source_dir/node_modules" "$runtime_dir/"
fi

chmod +x "$runtime_dir/scripts/launch-bridge.sh"

uid="$(id -u)"
launchctl bootstrap "gui/$uid" "$HOME/Library/LaunchAgents/com.local.codex-discord-bridge.plist" 2>/dev/null || true
launchctl kickstart -k "gui/$uid/com.local.codex-discord-bridge"
