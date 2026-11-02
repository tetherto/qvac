import test from 'node:test'
import assert from 'node:assert/strict'
import { platformPackageForHost } from './platform-package.mjs'

for (const legacy of [false, true]) {
  test(`resolves published platform mappings with fallback arrays: ${legacy}`, () => {
    const name = '@qvac/asr-ggml'
    const entry = (value) => legacy ? [value, './addon-unavailable.js'] : value
    const meta = { name, imports: { '#host-addon': {
      android: { arm64: entry(`${name}-android-arm64`) },
      ios: entry(`${name}-ios`)
    } } }
    assert.equal(platformPackageForHost(meta, 'android-arm64'), `${name}-android-arm64`)
    assert.equal(platformPackageForHost(meta, 'ios-arm64-simulator'), `${name}-ios`)
    assert.equal(platformPackageForHost(meta, 'linux-x64'), null)
  })
}

test('does not install a local fallback or a package belonging to another addon', () => {
  for (const value of ['./addon-unavailable.js', ['other-package', './addon-unavailable.js']]) {
    assert.equal(platformPackageForHost({ name: '@qvac/asr-ggml', imports: {
      '#host-addon': { android: { arm64: value } }
    } }, 'android-arm64'), null)
  }
})
