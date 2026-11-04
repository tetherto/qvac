#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
sdk_version="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",$/\1/p' package.json | head -1)"
if [[ -z "$sdk_version" ]]; then
  echo "Unable to read the Kotlin SDK version from package.json" >&2
  exit 1
fi

# consumer-smoke has one product flavour per published runtime artifact.
# Extra arguments go to Gradle, e.g. -PqvacProfile=aio to check one artifact.
./gradlew --no-daemon -p consumer-smoke clean :app:checkDebugBuild \
  -PqvacVersion="$sdk_version" "$@"
