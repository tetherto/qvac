'use strict'

const PLATFORM_PACKAGES = {
  'linux-x64': '@qvac/fabric-linux-x64',
  'linux-arm64': '@qvac/fabric-linux-arm64',
  'darwin-arm64': '@qvac/fabric-darwin-arm64',
  'darwin-x64': '@qvac/fabric-darwin-x64',
  'win32-x64': '@qvac/fabric-win32-x64'
}

function dirname (file) {
  const index = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return index === -1 ? '.' : file.slice(0, index)
}

// Node has `process`; Bare has the `Bare` global. Do not require('bare-os') —
// this file is loaded from Node (consumer CMake helpers) and Bare (binding.js).
function runtimeHost () {
  const proc = typeof process === 'undefined' ? null : process
  if (proc && proc.platform) return { platform: proc.platform, arch: proc.arch }
  const bare = typeof globalThis.Bare === 'undefined' ? null : globalThis.Bare
  if (bare && bare.platform) return { platform: bare.platform, arch: bare.arch }
  return { platform: undefined, arch: undefined }
}

function platformPackageName (platform, arch) {
  const host = runtimeHost()
  platform = platform || host.platform
  arch = arch || host.arch
  if (platform === 'ios') return '@qvac/fabric-ios'
  if (platform === 'android') return '@qvac/fabric-android-arm64'
  return PLATFORM_PACKAGES[`${platform}-${arch}`] || null
}

function resolvePlatformPrebuilds () {
  const packageName = platformPackageName()
  if (!packageName) return null
  try {
    return dirname(require.resolve(`${packageName}/package`)) + '/prebuilds'
  } catch {
    return null
  }
}

module.exports = { platformPackageName, resolvePlatformPrebuilds, runtimeHost }
