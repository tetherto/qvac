const META_PACKAGE = '@qvac/audiogen-ggml'

const PLATFORM_PACKAGES = {
  'linux-x64': META_PACKAGE + '-linux-x64',
  'linux-arm64': META_PACKAGE + '-linux-arm64',
  'darwin-arm64': META_PACKAGE + '-darwin-arm64',
  'darwin-x64': META_PACKAGE + '-darwin-x64',
  'win32-x64': META_PACKAGE + '-win32-x64',
  'android-arm64': META_PACKAGE + '-android-arm64',
  'ios-arm64': META_PACKAGE + '-ios',
  'ios-arm64-simulator': META_PACKAGE + '-ios',
  'ios-x64-simulator': META_PACKAGE + '-ios'
}

throw new Error(buildMessage(currentHost()))

function currentHost() {
  return (require.addon && require.addon.host) || 'unknown'
}

function buildMessage(host) {
  const platformPackage = PLATFORM_PACKAGES[host]
  if (!platformPackage) {
    return (
      META_PACKAGE +
      ' has no prebuilt binaries for host ' +
      host +
      '. Prebuilt hosts: ' +
      Object.keys(PLATFORM_PACKAGES).join(', ') +
      '. Build from source with bare-make.'
    )
  }
  return (
    META_PACKAGE +
    ' found no native prebuild for ' +
    host +
    ': the platform package ' +
    platformPackage +
    ' is not installed. It ships as an os/cpu filtered optional dependency, which Yarn v1 and installs using --omit=optional drop. Reinstall with npm 7+, pnpm, bun, or Yarn Berry, or build from source with bare-make.'
  )
}
