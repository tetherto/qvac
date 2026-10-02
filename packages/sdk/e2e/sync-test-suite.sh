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

# The mobile and Electron builds keep their own copy of the framework under
# `build/consumers/*/node_modules`, populated when the consumer was packaged.
# Refreshing only the e2e copy leaves those bundles running whatever was
# published, and the failure is silent rather than loud: an older reader does
# not reject a definition it does not fully understand, it just quietly does
# less with it. That is how a whole platform policy went missing on an iOS run
# while every local check passed.
synced_consumers=0
for consumer_dest in "$here"/build/consumers/*/node_modules/@qvac/test-suite; do
  [ -d "$consumer_dest" ] || continue
  rm -rf "$consumer_dest/dist" "$consumer_dest/schema"
  cp -R "$src/dist" "$consumer_dest/dist"
  cp -R "$src/schema" "$consumer_dest/schema"
  cp "$src/package.json" "$consumer_dest/package.json"
  synced_consumers=$((synced_consumers + 1))
done

echo "synced @qvac/test-suite from $src"
if [ "$synced_consumers" -gt 0 ]; then
  echo "  and $synced_consumers packaged consumer bundle(s)"
fi
