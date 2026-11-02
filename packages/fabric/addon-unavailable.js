'use strict'

// "#host-addon" target for hosts with no platform package. Hosts that have one
// map straight to it with no fallback, so a missing install fails bare-pack (and
// fails at run time naming the package) instead of producing a bundle that only
// throws once launched.
const host = require.addon ? require.addon.host : 'unknown'

throw new Error(
  '@qvac/fabric has no prebuilt runtime for host ' +
    host +
    '. Platform packages exist for ' +
    'linux-x64, linux-arm64, darwin-arm64, darwin-x64, win32-x64, android-arm64 and ios ' +
    '(ios-arm64, ios-arm64-simulator, ios-x64-simulator). Build from source with bare-make.'
)
