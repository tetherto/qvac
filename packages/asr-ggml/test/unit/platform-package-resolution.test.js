'use strict'

const test = require('brittle')
const { hostPlatformPackage } = require('../../lib/backends.js')
const packageJson = require('../../package.json')

const ADDON_UNAVAILABLE_TARGET = './addon-unavailable.js'
const PUBLISHED_HOSTS = [
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

function importsTargetsForHost(host) {
  const conditions = host.split('-')
  let target = packageJson.imports['#host-addon']
  while (target && !Array.isArray(target) && typeof target === 'object') {
    const matched = Object.keys(target).find(
      (condition) => condition === 'default' || conditions.includes(condition)
    )
    target = target[matched]
  }
  return Array.isArray(target) ? target : [target]
}

test('#host-addon falls back to the actionable error module when the platform package is absent', (t) => {
  const resolved = require.resolve('#host-addon')
  t.ok(resolved.endsWith('addon-unavailable.js'))
})

test('loading #host-addon without the platform package names the missing package', (t) => {
  try {
    require('#host-addon')
    t.fail('require must throw without an installed platform package')
  } catch (err) {
    t.ok(err.message.includes('@qvac/asr-ggml'))
    t.ok(err.message.includes(hostPlatformPackage(require.addon.host)))
  }
})

test('the imports map routes every published host to its platform package', (t) => {
  for (const host of PUBLISHED_HOSTS) {
    const targets = importsTargetsForHost(host)
    t.is(targets[0], hostPlatformPackage(host), host)
    t.is(targets[targets.length - 1], ADDON_UNAVAILABLE_TARGET, host)
  }
})

test('the imports map routes unpublished hosts to the actionable error module', (t) => {
  for (const host of ['android-x64', 'linux-riscv64', 'darwin-ppc64', 'freebsd-x64']) {
    t.alike(importsTargetsForHost(host), [ADDON_UNAVAILABLE_TARGET], host)
  }
})
