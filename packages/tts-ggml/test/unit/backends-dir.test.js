'use strict'

const test = require('brittle')
const path = require('bare-path')
const {
  hostPlatformPackage,
  resolveBackendsDirFrom,
  resolveBackendsDir
} = require('../../lib/backends.js')

const LOCAL_PREBUILDS = '/fake/package/prebuilds'

function sources(overrides = {}) {
  return {
    localPrebuildsDir: LOCAL_PREBUILDS,
    host: 'linux-x64',
    directoryExists: () => false,
    resolveManifest: () => null,
    ...overrides
  }
}

test('hostPlatformPackage maps desktop hosts one to one', (t) => {
  t.is(hostPlatformPackage('linux-x64'), '@qvac/tts-ggml-linux-x64')
  t.is(hostPlatformPackage('linux-arm64'), '@qvac/tts-ggml-linux-arm64')
  t.is(hostPlatformPackage('darwin-arm64'), '@qvac/tts-ggml-darwin-arm64')
  t.is(hostPlatformPackage('darwin-x64'), '@qvac/tts-ggml-darwin-x64')
  t.is(hostPlatformPackage('win32-x64'), '@qvac/tts-ggml-win32-x64')
  t.is(hostPlatformPackage('android-arm64'), '@qvac/tts-ggml-android-arm64')
})

test('hostPlatformPackage groups every ios flavour into the ios package', (t) => {
  t.is(hostPlatformPackage('ios-arm64'), '@qvac/tts-ggml-ios')
  t.is(hostPlatformPackage('ios-arm64-simulator'), '@qvac/tts-ggml-ios')
  t.is(hostPlatformPackage('ios-x64-simulator'), '@qvac/tts-ggml-ios')
})

test('prefers the local prebuilds dir when it exists', (t) => {
  const dir = resolveBackendsDirFrom(
    sources({
      directoryExists: (dir) => dir === LOCAL_PREBUILDS,
      resolveManifest: () => {
        t.fail('must not consult the platform package')
        return null
      }
    })
  )
  t.is(dir, LOCAL_PREBUILDS)
})

test('falls back to the installed platform package prebuilds', (t) => {
  const manifestPath = path.join('/fake/node_modules/@qvac/tts-ggml-linux-x64', 'package.json')
  const requested = []
  const dir = resolveBackendsDirFrom(
    sources({
      resolveManifest: (specifier) => {
        requested.push(specifier)
        return manifestPath
      }
    })
  )
  t.alike(requested, ['@qvac/tts-ggml-linux-x64/package'])
  t.is(dir, path.join('/fake/node_modules/@qvac/tts-ggml-linux-x64', 'addon', 'prebuilds'))
})

test('returns the local prebuilds path when nothing resolves', (t) => {
  t.is(resolveBackendsDirFrom(sources()), LOCAL_PREBUILDS)
  t.is(resolveBackendsDirFrom(sources({ host: null })), LOCAL_PREBUILDS)
})

test('resolveBackendsDir returns an absolute directory path', (t) => {
  const dir = resolveBackendsDir()
  t.is(typeof dir, 'string')
  t.ok(dir.length > 0)
})
