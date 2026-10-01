#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
sdk_version="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",$/\1/p' package.json | head -1)"
if [[ -z "$sdk_version" ]]; then
  echo "Unable to read the Kotlin SDK version from package.json" >&2
  exit 1
fi

artifacts=(
  qvac-sdk-android
  qvac-sdk-android-assistant
  qvac-sdk-android-llm
  qvac-sdk-android-speech
  qvac-sdk-android-vision
  qvac-sdk-android-media
  qvac-sdk-android-robotics
)

for artifact in "${artifacts[@]}"; do
  echo "Verifying io.tether:$artifact"
  ./gradlew --no-daemon -p consumer-smoke clean :app:assembleDebug \
    -PqvacArtifact="$artifact" \
    -PqvacVersion="$sdk_version"
done
