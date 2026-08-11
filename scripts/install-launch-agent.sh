#!/bin/zsh
set -euo pipefail

source_dir="${0:A:h:h}"
runtime_dir="${CODEX_DISCORD_RUNTIME_DIR:-$HOME/Library/Application Support/CodexDiscordBridge/app}"
agent_label="com.local.codex-discord-bridge"
agent_path="$HOME/Library/LaunchAgents/$agent_label.plist"
node_bin="${NODE_BIN:-$(command -v node)}"

if [ ! -f "$source_dir/.env" ]; then
  print -u2 "Missing $source_dir/.env. Copy .env.example and configure it first."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$runtime_dir/logs"

cat > "$agent_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$agent_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$runtime_dir/scripts/launch-bridge.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$runtime_dir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_BIN</key>
    <string>$node_bin</string>
    <key>PATH</key>
    <string>${PATH}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$runtime_dir/logs/bridge.out.log</string>
  <key>StandardErrorPath</key>
  <string>$runtime_dir/logs/bridge.err.log</string>
</dict>
</plist>
PLIST

plutil -lint "$agent_path"
"$source_dir/scripts/deploy-runtime.sh"
print "Installed and started $agent_label"
