#!/usr/bin/env bash
# Build a local Maven repository of the Kotlin SDK from a standalone checkout
# of packages/sdk-kotlin, without the rest of the monorepo.
#
#   install-local.sh <tag-or-branch> [directory]
#
# <tag-or-branch> is the release tag to build, such as sdk-v0.23.0; [directory]
# is where the sparse clone goes (default ./qvac-sdk-kotlin) and must not exist
# yet, so the build is always of the named ref. The build needs
# JDK 17, the Android SDK with NDK 29.0.14206865 and Node.js 22 on PATH, and
# bundles the @qvac/sdk version pinned by the checkout. Afterwards
# the directory printed last is ready to be added as a Gradle Maven repository.
#
# QVAC_REPO_URL overrides the repository to clone; QVAC_PROFILE limits the
# build to one Android runtime profile (aio, assistant, llm, speech, vision,
# media, robotics). Both are for testing this script.
set -euo pipefail

ref="${1:?usage: install-local.sh <tag-or-branch> [directory]}"
directory="${2:-qvac-sdk-kotlin}"
repository="${QVAC_REPO_URL:-https://github.com/tetherto/qvac}"
profile="${QVAC_PROFILE:-}"

ndk_version="29.0.14206865"
missing=0
fail() {
  echo "missing prerequisite: $*" >&2
  missing=1
}

for tool in git java node npm; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool on PATH"
done

if command -v java >/dev/null 2>&1; then
  # "17.0.2", "21", "1.8.0_292": the major is the first number unless it is 1.
  java_version="$(java -version 2>&1 | sed -n 's/.*version "\([0-9][0-9]*\)\(\.[0-9]*\)*.*/\1/p' | head -1)"
  if [ "${java_version:-0}" -lt 17 ]; then
    fail "JDK 17 or newer (found java ${java_version:-unknown})"
  fi
fi

if command -v node >/dev/null 2>&1; then
  node_version="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "${node_version:-0}" -lt 22 ]; then
    fail "Node.js 22 or newer (found $(node --version))"
  fi
fi

android_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$android_sdk" ]; then
  fail "ANDROID_HOME or ANDROID_SDK_ROOT pointing at an Android SDK"
elif [ ! -d "$android_sdk/platform-tools" ]; then
  fail "Android SDK platform-tools under $android_sdk"
elif [ ! -f "$android_sdk/ndk/$ndk_version/source.properties" ]; then
  fail "NDK $ndk_version under $android_sdk/ndk (sdkmanager 'ndk;$ndk_version')"
fi

if [ "$missing" -ne 0 ]; then
  exit 1
fi

if [ -e "$directory" ]; then
  echo "$directory already exists; remove it or pass another directory so the build is of $ref" >&2
  exit 1
fi
git clone --depth 1 --filter=blob:none --sparse --branch "$ref" "$repository" "$directory"
git -C "$directory" sparse-checkout set packages/sdk-kotlin

package="$directory/packages/sdk-kotlin"
gradle_args=(--no-daemon publishSdkToBuildRepository)
if [ -n "$profile" ]; then
  gradle_args+=("-PqvacProfile=$profile")
fi
"$package/gradlew" -p "$package" "${gradle_args[@]}"

repository_dir="$(cd "$package/build/maven-repository" && pwd)"
version="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",$/\1/p' "$package/package.json" | head -1)"
cat <<EOF

Kotlin SDK $version published to:
  $repository_dir

Add it next to the JitPack repository that serves bare-rpc-kotlin:

  // settings.gradle.kts
  dependencyResolutionManagement {
      repositories {
          google()
          mavenCentral()
          exclusiveContent {
              forRepository { maven("https://jitpack.io") }
              filter { includeGroupByRegex("com\\\\.github\\\\.holepunchto\\\\..*") }
          }
          maven { url = uri("$repository_dir") }
      }
  }

  // app/build.gradle.kts
  implementation("io.tether:qvac-sdk-android-llm:$version")
EOF
