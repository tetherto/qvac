'use strict'

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

function hostPlatformPackage (host) {
  const platform = host.split('-')[0]
  return PLATFORM_PACKAGE_PREFIX + (platform === IOS_PLATFORM ? IOS_PLATFORM : host)
}

function resolveBackendsDirFrom (sources) {
  if (!sources.host) return null
  const manifest = sources.resolveManifest(hostPlatformPackage(sources.host) + '/package')
  if (manifest === null) return null
  return dirname(manifest) + PLATFORM_ADDON_PREBUILDS
}

function resolveBackendsDir () {
  return resolveBackendsDirFrom({
    host: currentHost(),
    resolveManifest: safeResolveManifest
  })
}

function currentHost () {
  return require.addon ? require.addon.host : null
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
