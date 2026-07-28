#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
worker_root="$repository_root/sidecars/voxtral"
build_root="$worker_root/build"
output_root="$repository_root/src-tauri/sidecars"
target_name="voxtral-worker-aarch64-apple-darwin"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "The Voxtral worker must be built on arm64 macOS." >&2
  exit 1
fi

cd "$worker_root"
uv sync --frozen --python 3.11
uv run pytest
uv run pyinstaller \
  --noconfirm \
  --clean \
  --onedir \
  --name voxtral-worker \
  --distpath "$build_root/dist" \
  --workpath "$build_root/work" \
  --specpath "$build_root/spec" \
  worker.py

mkdir -p "$output_root/$target_name"
ditto "$build_root/dist/voxtral-worker" "$output_root/$target_name"
file "$output_root/$target_name/voxtral-worker"
