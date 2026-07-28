#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  exec "$repository_root/scripts/build-voxtral-sidecar.sh"
fi

echo "Skipping the local Voxtral worker on $(uname -s)/$(uname -m); hosted Voxtral remains available."
