#!/usr/bin/env bash
set -euo pipefail

version="${1:?usage: package-release-assets.sh VERSION [MAVEN_REPOSITORY] [OUTPUT_DIRECTORY]}"
repository="${2:-build/maven-repository}"
output_directory="${3:-build/release-assets}"

if [ ! -d "$repository/io/tether" ]; then
  echo "Kotlin Maven repository not found at $repository" >&2
  exit 1
fi

mkdir -p "$output_directory"
output_directory="$(cd "$output_directory" && pwd)"
find "$output_directory" -maxdepth 1 -type f \
  \( -name 'qvac-sdk-*-maven.zip' -o -name 'SHA256SUMS' \) -delete

copy_module() {
  local module="$1"
  local staging_root="$2"
  local source="$repository/io/tether/$module"

  if [ ! -d "$source/$version" ]; then
    echo "Missing io.tether:$module:$version in $repository" >&2
    exit 1
  fi

  mkdir -p "$staging_root/io/tether"
  mkdir -p "$staging_root/io/tether/$module"
  cp -R "$source/$version" "$staging_root/io/tether/$module/$version"
}

package_bundle() {
  local asset_name="$1"
  shift

  local staging_root
  staging_root="$(mktemp -d)"

  for module in "$@"; do
    copy_module "$module" "$staging_root"
  done

  (
    cd "$staging_root"
    zip -q -r "$output_directory/$asset_name" io
  )

  rm -rf "$staging_root"
}

android_profiles=(
  qvac-sdk-android
  qvac-sdk-android-assistant
  qvac-sdk-android-llm
  qvac-sdk-android-speech
  qvac-sdk-android-vision
  qvac-sdk-android-media
  qvac-sdk-android-robotics
)

for profile in "${android_profiles[@]}"; do
  package_bundle \
    "$profile-$version-maven.zip" \
    qvac-sdk-kotlin \
    qvac-sdk-kotlin-android \
    "$profile"
done

package_bundle \
  "qvac-sdk-kotlin-jvm-$version-maven.zip" \
  qvac-sdk-kotlin \
  qvac-sdk-kotlin-jvm

(
  cd "$output_directory"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum ./*-maven.zip > SHA256SUMS
  else
    shasum -a 256 ./*-maven.zip > SHA256SUMS
  fi
)

echo "Packaged Kotlin release assets in $output_directory"
