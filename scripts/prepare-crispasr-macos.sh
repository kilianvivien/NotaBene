#!/usr/bin/env bash
# Build and stage the exact CrispASR/GGML runtime NotaBene signs into its app.

set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "CrispASR staging is only required for the macOS desktop target."
  exit 0
fi

if [ "$(uname -m)" != "arm64" ]; then
  echo "warning: local CrispASR speech engines are unavailable on non-Apple-Silicon builds" >&2
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_DIR="$ROOT_DIR/src-tauri/native/crispasr"
SOURCE_DIR="$NATIVE_DIR/work/v0.8.23/source"
BUILD_DIR="$NATIVE_DIR/work/v0.8.23/build"
STAGE_DIR="$NATIVE_DIR/arm64/src"
STAMP_FILE="$STAGE_DIR/.notabene-crispasr-version"
PATCH_FILE="$ROOT_DIR/scripts/patches/crispasr-voxtral-bounded-codec.patch"
[ -f "$PATCH_FILE" ] || {
  echo "error: the NotaBene CrispASR patch is missing" >&2
  exit 1
}
PATCH_SHA="$(shasum -a 256 "$PATCH_FILE" | awk '{print $1}')"

CRISPASR_TAG="v0.8.23"
CRISPASR_COMMIT="7d22deeca045f9c80020bf59e6a24564b1d66e5b"
GGML_COMMIT="bfe8ea228d8134d03641c9fcf233a9931f3730de"
STAMP_VALUE="$CRISPASR_TAG:$CRISPASR_COMMIT:$GGML_COMMIT:$PATCH_SHA:macos13-arm64-metal-noblas"

LIBRARIES=(
  "libcrispasr.1.dylib"
  "libggml.0.dylib"
  "libggml-base.0.dylib"
  "libggml-cpu.0.dylib"
  "libggml-metal.0.dylib"
)

verify_stage() {
  [ -f "$STAMP_FILE" ] || return 1
  [ "$(tr -d '\n' < "$STAMP_FILE")" = "$STAMP_VALUE" ] || return 1
  for library in "${LIBRARIES[@]}"; do
    [ -f "$STAGE_DIR/$library" ] || return 1
    file "$STAGE_DIR/$library" | grep -q "arm64" || return 1
  done
}

stage_dev_frameworks() {
  # crispasr-sys uses the app-bundle rpath. Mirror that layout beside Cargo
  # executables so `tauri dev` and Rust tests exercise the same dylib closure.
  for framework_dir in \
    "$ROOT_DIR/src-tauri/target/Frameworks" \
    "$ROOT_DIR/src-tauri/target/debug/Frameworks" \
    "$ROOT_DIR/src-tauri/target/release/Frameworks"; do
    mkdir -p "$framework_dir"
    for library in "${LIBRARIES[@]}"; do
      ln -sfn "$STAGE_DIR/$library" "$framework_dir/$library"
    done
  done
}

if verify_stage; then
  stage_dev_frameworks
  echo "CrispASR $CRISPASR_TAG is already staged."
  exit 0
fi

command -v git >/dev/null || { echo "error: git is required" >&2; exit 1; }
command -v cmake >/dev/null || { echo "error: cmake is required" >&2; exit 1; }
command -v ninja >/dev/null || { echo "error: ninja is required" >&2; exit 1; }
command -v otool >/dev/null || { echo "error: otool is required" >&2; exit 1; }
command -v install_name_tool >/dev/null || {
  echo "error: install_name_tool is required" >&2
  exit 1
}

mkdir -p "$(dirname "$SOURCE_DIR")"
if [ ! -d "$SOURCE_DIR/.git" ]; then
  git clone \
    --branch "$CRISPASR_TAG" \
    --depth 1 \
    --recurse-submodules \
    --shallow-submodules \
    https://github.com/CrispStrobe/CrispASR.git \
    "$SOURCE_DIR"
fi

[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$CRISPASR_COMMIT" ] || {
  echo "error: the CrispASR checkout is not the pinned commit" >&2
  exit 1
}
[ "$(git -C "$SOURCE_DIR/ggml" rev-parse HEAD)" = "$GGML_COMMIT" ] || {
  echo "error: the GGML submodule is not the pinned commit" >&2
  exit 1
}
if git -C "$SOURCE_DIR" apply --reverse --check "$PATCH_FILE" >/dev/null 2>&1; then
  echo "NotaBene's bounded Voxtral codec patch is already applied."
elif git -C "$SOURCE_DIR" apply --check "$PATCH_FILE"; then
  git -C "$SOURCE_DIR" apply "$PATCH_FILE"
else
  echo "error: the NotaBene CrispASR patch does not apply to the pinned source" >&2
  exit 1
fi

cmake \
  -S "$SOURCE_DIR" \
  -B "$BUILD_DIR" \
  -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DBUILD_SHARED_LIBS=ON \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_BLAS=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_CCACHE=OFF \
  -DCRISPASR_BUILD_TESTS=OFF \
  -DCRISPASR_BUILD_EXAMPLES=OFF \
  -DCRISPASR_BUILD_SERVER=OFF \
  -DCRISPASR_OPUS=OFF \
  -DCRISPASR_AMR=OFF
cmake --build "$BUILD_DIR" --config Release --parallel --target crispasr-lib

mkdir -p "$STAGE_DIR"
find "$STAGE_DIR" -maxdepth 1 -type f -name '*.dylib' -delete

cp -L "$BUILD_DIR/src/libcrispasr.1.dylib" "$STAGE_DIR/libcrispasr.1.dylib"
cp -L "$BUILD_DIR/ggml/src/libggml.0.dylib" "$STAGE_DIR/libggml.0.dylib"
cp -L "$BUILD_DIR/ggml/src/libggml-base.0.dylib" "$STAGE_DIR/libggml-base.0.dylib"
cp -L "$BUILD_DIR/ggml/src/libggml-cpu.0.dylib" "$STAGE_DIR/libggml-cpu.0.dylib"
cp -L \
  "$BUILD_DIR/ggml/src/ggml-metal/libggml-metal.0.dylib" \
  "$STAGE_DIR/libggml-metal.0.dylib"

# `-lcrispasr` needs the unversioned name while the dylib's install id remains
# the versioned bundle-relative name used at runtime.
ln -sfn "libcrispasr.1.dylib" "$STAGE_DIR/libcrispasr.dylib"

for library in "${LIBRARIES[@]}"; do
  path="$STAGE_DIR/$library"
  while read -r old_rpath; do
    case "$old_rpath" in
      @*) ;;
      *) install_name_tool -delete_rpath "$old_rpath" "$path" ;;
    esac
  done < <(
    otool -l "$path" |
      awk '/LC_RPATH/{found=1; next} found && / path /{print $2; found=0}'
  )
  install_name_tool -add_rpath "@loader_path" "$path" 2>/dev/null || true

  while read -r dependency; do
    case "$dependency" in
      /System/*|/usr/lib/*) ;;
      @rpath/libcrispasr.1.dylib|@rpath/libggml.0.dylib|@rpath/libggml-base.0.dylib|@rpath/libggml-cpu.0.dylib|@rpath/libggml-metal.0.dylib) ;;
      *)
        echo "error: unexpected dependency in $library: $dependency" >&2
        exit 1
        ;;
    esac
  done < <(otool -L "$path" | tail -n +2 | awk '{print $1}')

  # install_name_tool invalidates the build signature. Tauri applies the final
  # nested signature to the copy inside NotaBene.app.
  codesign --force --sign - "$path"
done

printf '%s\n' "$STAMP_VALUE" > "$STAMP_FILE"
verify_stage || { echo "error: staged CrispASR runtime failed verification" >&2; exit 1; }
stage_dev_frameworks
echo "Staged CrispASR $CRISPASR_TAG in $STAGE_DIR"
