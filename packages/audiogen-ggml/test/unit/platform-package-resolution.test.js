'use strict'

const test = require('brittle')
const { hostPlatformPackage } = require('../../lib/backends.js')

test('#host-addon falls back to the actionable error module when the platform package is absent', (t) => {
  const resolved = require.resolve('#host-addon')
  t.ok(resolved.endsWith('addon-unavailable.js'))
})

test('loading #host-addon without the platform package names the missing package', (t) => {
  try {
    require('#host-addon')
    t.fail('require must throw without an installed platform package')
  } catch (err) {
    t.ok(err.message.includes('@qvac/audiogen-ggml'))
    t.ok(err.message.includes(hostPlatformPackage(require.addon.host)))
  }
})
