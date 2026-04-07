#!/usr/bin/env bash

set -euo pipefail

TARGET_FILES=(
  "packages/qvac-lib-infer-llamacpp-llm/vcpkg.json"
  "packages/qvac-lib-infer-llamacpp-embed/vcpkg.json"
  "packages/qvac-lib-infer-nmtcpp/vcpkg.json"
)

extract_fabric_version() {
  local file_path="$1"
  local version

  version="$(jq -r '
    .dependencies
    | if type == "array" then . else [] end
    | map(select(type == "object" and .name == "qvac-fabric"))[0]
    | if . == null then "__MISSING_DEP__"
      elif (.["version>="] // "") != "" then .["version>="]
      elif (.version // "") != "" then .version
      elif (.["version-semver"] // "") != "" then .["version-semver"]
      else "__MISSING_VERSION__"
      end
  ' "$file_path")"

  if [ "$version" = "__MISSING_DEP__" ]; then
    echo "Dependency \"qvac-fabric\" not found in \"$file_path\"" >&2
    exit 1
  fi

  if [ "$version" = "__MISSING_VERSION__" ]; then
    echo "Dependency \"qvac-fabric\" in \"$file_path\" is missing a version key (version>=, version, version-semver)" >&2
    exit 1
  fi

  echo "$version"
}

first_version=""
has_divergence=0
results=()

for file_path in "${TARGET_FILES[@]}"; do
  version="$(extract_fabric_version "$file_path")"
  results+=("$file_path:$version")

  if [ -z "$first_version" ]; then
    first_version="$version"
    continue
  fi

  if [ "$version" != "$first_version" ]; then
    has_divergence=1
  fi
done

if [ "$has_divergence" -eq 0 ]; then
  echo "qvac-fabric lockstep check passed: $first_version"
  exit 0
fi

echo "qvac-fabric lockstep check failed: versions diverged." >&2
for result in "${results[@]}"; do
  file_path="${result%%:*}"
  version="${result#*:}"
  echo "- $file_path: $version" >&2
done

exit 1
