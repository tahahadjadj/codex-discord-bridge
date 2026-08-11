#!/bin/zsh
set -e

script_dir="${0:A:h}"
cd "${script_dir:h}"
node_bin="${NODE_BIN:-$(command -v node)}"
exec "$node_bin" src/index.js
