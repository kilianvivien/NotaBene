#!/usr/bin/env bash
#
# Build a signed, self-updating NotaBene release and (with --upload) attach it
# to the GitHub release for its tag.
#
#   scripts/release.sh            build + sign + write release/<version>/latest.json
#   scripts/release.sh --upload   …then create a DRAFT release v<version> (or add
#                                 to an existing one) with the DMG, the updater
#                                 bundle, its signature and latest.json
#
# How the update reaches people: every installed copy (1.4.9 and later) reads
#   https://github.com/kilianvivien/NotaBene/releases/latest/download/latest.json
# compares versions, downloads the `.app.tar.gz` it names, checks it against the
# public key in `src-tauri/tauri.conf.json`, and replaces itself. A draft is not
# "latest", so publishing the draft is what makes an update go live.
#
# One-time setup (a human step — the private key is the whole security model):
#   1. pnpm tauri signer generate -w ~/.tauri/notabene.key
#      Back the key up in a password manager. Lose it and no installed copy can
#      ever be updated again; leak it and anyone can update them.
#   2. Paste the single line in ~/.tauri/notabene.key.pub into
#      `plugins.updater.pubkey` in src-tauri/tauri.conf.json, and commit it.
#   3. If the key has a password, export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
#      before running this script.
#
# The app stays ad-hoc signed (plan §9): the updater's minisign signature is
# what proves a download came from here, not an Apple certificate.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REPO="kilianvivien/NotaBene"
KEY_FILE="${NOTABENE_UPDATER_KEY:-$HOME/.tauri/notabene.key}"
UPLOAD=0
[ "${1:-}" = "--upload" ] && UPLOAD=1

die() { echo "release: $*" >&2; exit 1; }

# --- The three version files must agree --------------------------------------
VERSION="$(node -p "require('./package.json').version")"
CONF_VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
CARGO_VERSION="$(sed -n 's/^version = "\(.*\)"$/\1/p' src-tauri/Cargo.toml | head -1)"
[ "$VERSION" = "$CONF_VERSION" ] && [ "$VERSION" = "$CARGO_VERSION" ] ||
  die "versions disagree: package.json $VERSION, tauri.conf.json $CONF_VERSION, Cargo.toml $CARGO_VERSION"
TAG="v$VERSION"

# --- Signing prerequisites, checked before a ten-minute build ------------------
PUBKEY="$(node -p "require('./src-tauri/tauri.conf.json').plugins?.updater?.pubkey ?? ''")"
[ -n "$PUBKEY" ] || die "plugins.updater.pubkey is empty in src-tauri/tauri.conf.json (see the setup at the top of this script)"
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  [ -f "$KEY_FILE" ] || die "no signing key: set TAURI_SIGNING_PRIVATE_KEY or create $KEY_FILE"
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
fi
export TAURI_SIGNING_PRIVATE_KEY
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# --- Build ----------------------------------------------------------------------
"$ROOT_DIR/scripts/tauri-build.sh" --config src-tauri/tauri.updater.conf.json

BUNDLE="src-tauri/target/release/bundle"
DMG="$BUNDLE/dmg/NotaBene_${VERSION}_aarch64.dmg"
APP_TGZ="$BUNDLE/macos/NotaBene.app.tar.gz"
[ -f "$DMG" ] || die "missing $DMG"
[ -s "$APP_TGZ" ] || die "missing $APP_TGZ — the updater has nothing to download"
[ -s "$APP_TGZ.sig" ] || die "missing $APP_TGZ.sig — check the signing key"

# The packaged app must be the version being released, or every installed copy
# would see an "update" to itself on each check.
PLIST="$BUNDLE/macos/NotaBene.app/Contents/Info.plist"
BUILT="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")"
[ "$BUILT" = "$VERSION" ] || die "bundle reports $BUILT, expected $VERSION"

# --- Stage the release assets -----------------------------------------------------
OUT="release/$VERSION"
rm -rf "$OUT"
mkdir -p "$OUT"
# Versioned names, so a release page never holds two files called the same
# thing from different builds.
UPDATER_NAME="NotaBene_${VERSION}_aarch64.app.tar.gz"
cp "$DMG" "$OUT/"
cp "$APP_TGZ" "$OUT/$UPDATER_NAME"
cp "$APP_TGZ.sig" "$OUT/$UPDATER_NAME.sig"

# Notes for the in-app popover: this version's section of RELEASE_NOTES.md, up
# to the verification paragraphs, without Markdown emphasis.
NOTES="$(awk -v v="$VERSION" '
  index($0, "## NotaBene " v " ") == 1 { on = 1; next }
  on && (/^## / || /^\*\*Verification/ || /^\*\*Download/) { exit }
  on { print }
' RELEASE_NOTES.md | sed -e 's/\*\*//g' | sed -e '/./,$!d')"
[ -n "$NOTES" ] || echo "release: warning — no '## NotaBene $VERSION' section in RELEASE_NOTES.md" >&2

node - "$OUT/latest.json" "$VERSION" "$OUT/$UPDATER_NAME.sig" \
  "https://github.com/$REPO/releases/download/$TAG/$UPDATER_NAME" "$NOTES" <<'NODE'
const fs = require('fs');
const [file, version, sigFile, url, notes] = process.argv.slice(2);
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms: {
    'darwin-aarch64': { signature: fs.readFileSync(sigFile, 'utf8').trim(), url },
  },
};
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
NODE

( cd "$OUT" && shasum -a 256 "NotaBene_${VERSION}_aarch64.dmg" )
echo "release: staged $OUT"
ls -l "$OUT"

[ "$UPLOAD" = 1 ] || { echo "release: run again with --upload, or upload $OUT/* to $TAG yourself"; exit 0; }

# --- Upload -------------------------------------------------------------------------
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" --repo "$REPO" --clobber "$OUT"/*
else
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "tag $TAG does not exist — tag and push it first"
  gh release create "$TAG" --repo "$REPO" --draft --verify-tag \
    --title "NotaBene $VERSION" --notes "$NOTES" "$OUT"/*
fi
echo "release: assets are on $TAG. Publishing the release is what makes the update live."
