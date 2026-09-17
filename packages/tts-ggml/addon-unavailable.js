const { hostPlatformPackage, PREBUILT_HOSTS } = require('./lib/backends.js')

const META_PACKAGE = '@qvac/tts-ggml'
const UNKNOWN_HOST = 'unknown'

throw new Error(buildMessage(currentHost()))

function currentHost() {
  return require.addon ? require.addon.host : null
}

function buildMessage(host) {
  if (!host || !PREBUILT_HOSTS.includes(host)) {
    return (
      META_PACKAGE +
      ' has no prebuilt binaries for host ' +
      (host || UNKNOWN_HOST) +
      '. Prebuilt hosts: ' +
      PREBUILT_HOSTS.join(', ') +
      '. Build from source with bare-make.'
    )
  }
  return (
    META_PACKAGE +
    ' found no native prebuild for ' +
    host +
    ': the platform package ' +
    hostPlatformPackage(host) +
    ' is not installed. It ships as an os/cpu filtered optional dependency, which Yarn v1 and installs using --omit=optional drop. Reinstall with npm 7+, pnpm, bun, or Yarn Berry, or build from source with bare-make.'
  )
}
