'use strict'

// Last target of every "#host-addon" arm. Reaching it means neither this
// package's prebuilds nor the host's platform package held a runtime.
const { hostPlatformPackage, PREBUILT_HOSTS } = require('./backends.js')

const META_PACKAGE = '@qvac/fabric'
const UNKNOWN_HOST = 'unknown'
const CROSS_BUILT_PLATFORMS = ['android', 'ios']

throw new Error(buildMessage(require.addon ? require.addon.host : null))

function buildMessage(host) {
  if (!host || !PREBUILT_HOSTS.includes(host)) {
    return (
      META_PACKAGE +
      ' has no prebuilt runtime for host ' +
      (host || UNKNOWN_HOST) +
      '. Prebuilt hosts: ' +
      PREBUILT_HOSTS.join(', ') +
      '. Build from source with bare-make.'
    )
  }
  const platformPackage = hostPlatformPackage(host)
  const missing =
    META_PACKAGE +
    ' found no runtime for ' +
    host +
    ': the platform package ' +
    platformPackage +
    ' is not installed. '
  if (CROSS_BUILT_PLATFORMS.includes(host.split('-')[0])) {
    return (
      missing +
      'Cross-built targets are never selected by os/cpu filters: add ' +
      platformPackage +
      ' as a direct dependency pinned to the exact ' +
      META_PACKAGE +
      ' version.'
    )
  }
  return (
    missing +
    'It ships as an os/cpu filtered optional dependency, which Yarn v1 and ' +
    'installs using --omit=optional drop. Reinstall with npm 7+, pnpm, bun, or Yarn Berry, ' +
    'or build from source with bare-make.'
  )
}
