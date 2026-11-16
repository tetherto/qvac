#!/usr/bin/env bash
# Installs this checkout's @qvac/sdk and @qvac/inference into packages/sdk-kotlin
# in place of the registry versions, so the Kotlin SDK builds and tests against
# this commit. A PR into a release branch pins an @qvac/sdk version that is not
# on npm yet, so the registry install in :android-barekit:npmCi would fail.
#
# Resets packages/sdk/package.json to its committed content before and after
# the build, so uncommitted edits to that file are lost. Leaves the swapped
# @qvac/sdk dependency in packages/sdk-kotlin/package.json.
#
# packages/sdk/dist is built here, so run Gradle afterwards with
# -x :android-barekit:buildWorkspaceSdk.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# sdk-source:workspace installs and builds the sibling @qvac/inference, points
# the SDK's @qvac/inference at file:../inference and installs the SDK with
# --install-links, so tsc sees this commit's inference surface. The committed
# package.json is restored before packing so the tarball depends on the
# published @qvac/inference range. Lint is left to sdk-pod-checks.
cd "$repo_root/packages/sdk"
git checkout -- package.json
npm run sdk-source:workspace
npx tsc --project tsconfig.json
npm run postcompile:aliases
git checkout -- package.json
sdk_tgz="$(npm pack --ignore-scripts --silent)"

cd "$repo_root/packages/inference"
inf_tgz="$(npm pack --ignore-scripts --silent)"

cd "$repo_root/packages/sdk-kotlin"
# @qvac/inference reaches sdk-kotlin only through @qvac/sdk, so npm accepts an
# override for it; npm rejects one for a direct dependency (EOVERRIDE).
npm pkg set "overrides.@qvac/inference=file:../inference/${inf_tgz}"
# A file:../sdk dependency would be a symlink whose own dependencies (bare-rpc,
# @qvac/inference, ...) are not installed into sdk-kotlin. The tarball installs
# the full dependency tree the way a registry install does.
npm install --ignore-scripts --legacy-peer-deps --no-package-lock "../sdk/${sdk_tgz}"
