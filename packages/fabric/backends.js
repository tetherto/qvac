'use strict'

// Hosts scripts/ci/slice-platform-packages.mjs publishes a platform package for.
const PREBUILT_HOSTS = [
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'android-arm64',
  'ios-arm64',
  'ios-arm64-simulator',
  'ios-x64-simulator'
]

const PLATFORM_PACKAGE_PREFIX = '@qvac/fabric-'
const PLATFORM_ADDON_PREBUILDS = '/addon/prebuilds'
const IOS_PLATFORM = 'ios'
const BARE_EXTENSION = '.bare'

function hostPlatformPackage (host) {
  const platform = host.split('-')[0]
  return PLATFORM_PACKAGE_PREFIX + (platform === IOS_PLATFORM ? IOS_PLATFORM : host)
}

// The root a consumer passes as backendsDir: the native side appends
// "<host>/qvac__fabric", which sits next to the loaded qvac__fabric.bare. The
// precedence is binding.js's: a runtime Bare resolves for this package (source
// build, CI overlay, the unsliced GPR tarball) wins over the platform package.
// Returns null when neither is on disk, e.g. inside a packed mobile bundle.
function resolveBackendsDirFrom (sources) {
  const localAddon = sources.resolveLocalAddon()
  if (localAddon !== null && localAddon.endsWith(BARE_EXTENSION)) {
    return dirname(dirname(localAddon))
  }
  if (!sources.host) return null
  const manifest = sources.resolveManifest(hostPlatformPackage(sources.host) + '/package')
  if (manifest === null) return null
  return dirname(manifest) + PLATFORM_ADDON_PREBUILDS
}

function resolveBackendsDir () {
  return resolveBackendsDirFrom({
    host: currentHost(),
    resolveLocalAddon: safeResolveLocalAddon,
    resolveManifest: safeResolveManifest
  })
}

function currentHost () {
  return require.addon ? require.addon.host : null
}

function safeResolveLocalAddon () {
  try {
    return require.addon.resolve('.')
  } catch {
    return null
  }
}

function safeResolveManifest (specifier) {
  try {
    return require.resolve(specifier)
  } catch {
    return null
  }
}

function dirname (file) {
  const index = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return index === -1 ? '.' : file.slice(0, index)
}

module.exports = {
  PREBUILT_HOSTS,
  hostPlatformPackage,
  resolveBackendsDir,
  resolveBackendsDirFrom
}
