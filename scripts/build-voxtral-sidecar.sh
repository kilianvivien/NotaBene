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
  --collect-data mlx \
  --hidden-import mlx._reprlib_fix \
  --collect-submodules mlx_audio.tts.models.voxtral_tts \
  --distpath "$build_root/dist" \
  --workpath "$build_root/work" \
  --specpath "$build_root/spec" \
  worker.py

rm -rf "$output_root/$target_name"
mkdir -p "$output_root/$target_name"
ditto "$build_root/dist/voxtral-worker" "$output_root/$target_name"
# PyInstaller also places libmlx.dylib at `_internal/libmlx.dylib`. When the
# worker lives inside a macOS `.app`, dyld can select that duplicate instead of
# `mlx/lib/libmlx.dylib`; MLX resolves its default shader library beside the
# dylib it actually loaded. Keep the identical metallib in both locations.
cp \
  "$output_root/$target_name/_internal/mlx/lib/mlx.metallib" \
  "$output_root/$target_name/_internal/mlx.metallib"
"$output_root/$target_name/voxtral-worker" --runtime-check
codesign --verify --deep --strict "$output_root/$target_name/voxtral-worker"
file "$output_root/$target_name/voxtral-worker"
