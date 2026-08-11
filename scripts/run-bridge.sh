#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

node_bin="${NODE_BIN:-$(command -v node)}"
exec "$node_bin" src/index.js
