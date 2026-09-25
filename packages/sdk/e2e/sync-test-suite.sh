#!/usr/bin/env bash
# Point this checkout's e2e run at the test-suite source next to it.
#
# `package.json` pins `@qvac/test-suite` to a published range, so a plain
# install leaves node_modules holding the registry build and a local change to
# the framework is silently not under test. CI does this properly --
# `test-suite-source: branch` builds the package from the branch -- so this is
# the local equivalent, and running it is the difference between verifying your
# change and verifying the last release.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/../../test-suite"
dest="$here/node_modules/@qvac/test-suite"

( cd "$src" && npm run build >/dev/null )
rm -rf "$dest/dist" "$dest/schema"
cp -R "$src/dist" "$dest/dist"
cp -R "$src/schema" "$dest/schema"
cp "$src/package.json" "$dest/package.json"

# The copy loses the executable bit, and `npx qvac-test` resolves through a
# symlink to this file -- without it every local command has to be spelled
# `node .../dist/cli/index.js`, which is the kind of papercut people work
# around instead of reporting.
chmod +x "$dest/dist/cli/index.js"

echo "synced @qvac/test-suite from $src"
