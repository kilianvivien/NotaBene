#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$ROOT_DIR/scripts/prepare-crispasr-macos.sh"

if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  exec pnpm tauri build --config src-tauri/tauri.arm64.conf.json "$@"
fi

exec pnpm tauri build "$@"
