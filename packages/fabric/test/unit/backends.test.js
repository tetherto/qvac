'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { evaluate, packageRoot } = require('./helpers')
const {
  PREBUILT_HOSTS,
  hostPlatformPackage,
  resolveBackendsDirFrom
} = require('../../backends.js')

const slicerUrl = pathToFileURL(
  path.resolve(packageRoot, '../../scripts/ci/slice-platform-packages.mjs')
).href

const FABRIC_ROOT = '/app/node_modules/@qvac/fabric'
const PLATFORM_ROOT = '/app/node_modules/@qvac/fabric-linux-x64'

function sources (overrides = {}) {
  return {
    host: 'linux-x64',
    resolveLocalAddon: () => null,
    resolveManifest: (specifier) =>
      specifier === '@qvac/fabric-linux-x64/package' ? PLATFORM_ROOT + '/package.json' : null,
    ...overrides
  }
}

test('a runtime in this package wins over the platform package', () => {
  const dir = resolveBackendsDirFrom(sources({
    resolveLocalAddon: () => FABRIC_ROOT + '/prebuilds/linux-x64/qvac__fabric.bare'
  }))

  assert.equal(dir, FABRIC_ROOT + '/prebuilds')
})

test('a versioned runtime in this package resolves to the same root', () => {
  const dir = resolveBackendsDirFrom(sources({
    resolveLocalAddon: () => FABRIC_ROOT + '/prebuilds/linux-x64/qvac__fabric@0.18.0.bare'
  }))

  assert.equal(dir, FABRIC_ROOT + '/prebuilds')
})

test('Windows paths resolve to the prebuilds root', () => {
  const dir = resolveBackendsDirFrom(sources({
    host: 'win32-x64',
    resolveLocalAddon: () => 'C:\\app\\node_modules\\@qvac\\fabric\\prebuilds\\win32-x64\\qvac__fabric.bare'
  }))

  assert.equal(dir, 'C:\\app\\node_modules\\@qvac\\fabric\\prebuilds')
})

test('without a local runtime the platform package addon/ prebuilds are used', () => {
  assert.equal(resolveBackendsDirFrom(sources()), PLATFORM_ROOT + '/addon/prebuilds')
})

test('a linked mobile runtime is not treated as a prebuilds directory', () => {
  const dir = resolveBackendsDirFrom(sources({
    host: 'ios-arm64',
    resolveLocalAddon: () => 'linked:qvac__fabric.0.18.0.framework/qvac__fabric.0.18.0',
    resolveManifest: () => null
  }))

  assert.equal(dir, null)
})

test('returns null when neither source is on disk', () => {
  assert.equal(resolveBackendsDirFrom(sources({ resolveManifest: () => null })), null)
  assert.equal(resolveBackendsDirFrom(sources({ host: null })), null)
})

test('every ios flavour maps to the one ios package', () => {
  for (const host of ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']) {
    assert.equal(hostPlatformPackage(host), '@qvac/fabric-ios', host)
  }
  assert.equal(hostPlatformPackage('android-arm64'), '@qvac/fabric-android-arm64')
  assert.equal(hostPlatformPackage('linux-arm64'), '@qvac/fabric-linux-arm64')
})

test('PREBUILT_HOSTS matches the hosts the slicer publishes', async () => {
  const { SLICE_DEFINITIONS, hostToSliceSuffix } = await import(slicerUrl)
  const sliced = SLICE_DEFINITIONS.flatMap((definition) => definition.hosts)

  assert.deepEqual([...PREBUILT_HOSTS].sort(), [...sliced].sort())
  for (const host of PREBUILT_HOSTS) {
    assert.equal(hostPlatformPackage(host), '@qvac/fabric-' + hostToSliceSuffix(host), host)
  }
})

test('resolveBackendsDir consults Bare for the local runtime and the platform package', () => {
  const { exports } = evaluate('backends.js', () => {
    const fakeRequire = (specifier) => {
      throw new Error(`unexpected require(${specifier})`)
    }
    fakeRequire.resolve = (specifier) => {
      if (specifier === '@qvac/fabric-darwin-arm64/package') return '/n/@qvac/fabric-darwin-arm64/package.json'
      throw new Error('MODULE_NOT_FOUND')
    }
    fakeRequire.addon = () => notCalled()
    fakeRequire.addon.host = 'darwin-arm64'
    fakeRequire.addon.resolve = () => {
      throw new Error('ADDON_NOT_FOUND')
    }
    return fakeRequire
  })

  assert.equal(exports.resolveBackendsDir(), '/n/@qvac/fabric-darwin-arm64/addon/prebuilds')
})

function notCalled () {
  throw new Error('should not have been reached')
}
