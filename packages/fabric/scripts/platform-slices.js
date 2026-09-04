'use strict'

// Single source of published platform-package names. The meta package, slicer,
// CMake helper, and overlay action must stay aligned with this table.
const SLICES = [
  { name: 'linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc' },
  { name: 'linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  { name: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
  { name: 'darwin-x64', os: 'darwin', cpu: 'x64' },
  { name: 'win32-x64', os: 'win32', cpu: 'x64' },
  { name: 'android-arm64', os: 'android', groupPrefix: 'android-' },
  { name: 'ios', os: 'ios', groupPrefix: 'ios-' }
]

const ANDROID_FLAVOURS = ['android-arm', 'android-ia32', 'android-x64']

const LINUX_X64_BUDGET = 512 * 1024 * 1024
const ANDROID_BUDGET = 512 * 1024 * 1024
const DEFAULT_BUDGET = 256 * 1024 * 1024

function npmPackageName (sliceName) {
  return `@qvac/fabric-${sliceName}`
}

function gprPackageName (sliceName) {
  return `@tetherto/fabric-${sliceName}-mono`
}

function packageNameForHost (platform, arch) {
  if (platform === 'ios') return npmPackageName('ios')
  if (platform === 'android') return npmPackageName('android-arm64')
  if (!platform || !arch) return null
  return npmPackageName(`${platform}-${arch}`)
}

function packageNameForBareTarget (bareTarget) {
  if (bareTarget.startsWith('ios-')) return npmPackageName('ios')
  if (bareTarget.startsWith('android-')) return npmPackageName('android-arm64')
  return npmPackageName(bareTarget)
}

function bareAddonBasename (packageName) {
  return packageName.replace(/^@/, '').replace('/', '__')
}

function unpackedBudgetBytes (sliceName) {
  if (sliceName === 'linux-x64') return LINUX_X64_BUDGET
  if (sliceName === 'android-arm64') return ANDROID_BUDGET
  return DEFAULT_BUDGET
}

function expectedOptionalDependencies (version) {
  const deps = {}
  for (const slice of SLICES) deps[npmPackageName(slice.name)] = version
  return deps
}

function expectedImports () {
  return {
    '#binding': {
      android: npmPackageName('android-arm64'),
      darwin: {
        arm64: npmPackageName('darwin-arm64'),
        x64: npmPackageName('darwin-x64')
      },
      ios: npmPackageName('ios'),
      linux: {
        arm64: npmPackageName('linux-arm64'),
        x64: npmPackageName('linux-x64')
      },
      win32: {
        x64: npmPackageName('win32-x64')
      }
    }
  }
}

module.exports = {
  ANDROID_FLAVOURS,
  SLICES,
  bareAddonBasename,
  expectedImports,
  expectedOptionalDependencies,
  gprPackageName,
  npmPackageName,
  packageNameForBareTarget,
  packageNameForHost,
  unpackedBudgetBytes
}
