'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const packageJson = require('../../package.json')

const PACKAGE_ROOT = path.join(__dirname, '..', '..')
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

function platformPackage(host) {
  return '@qvac/asr-ggml-' + (host.startsWith('ios-') ? 'ios' : host)
}

function importsTargetForHost(host) {
  const conditions = host.split('-')
  let target = packageJson.imports['#host-addon']
  while (target && typeof target === 'object') {
    const matched = Object.keys(target).find(
      (condition) => condition === 'default' || conditions.includes(condition)
    )
    target = target[matched]
  }
  return target
}

test('binding.js is the one line the module lexer can follow', (t) => {
  const source = fs.readFileSync(path.join(PACKAGE_ROOT, 'binding.js'), 'utf8')
  t.is(source, "module.exports = require('#host-addon')\n")
})

test('the meta package is not an addon: its platform packages are', (t) => {
  t.is(packageJson.addon, undefined)
})

test('the imports map routes every published host to its platform package alone', (t) => {
  for (const host of PUBLISHED_HOSTS) {
    t.is(importsTargetForHost(host), platformPackage(host), host)
  }
})

test('the imports map routes unpublished hosts to the actionable error module', (t) => {
  for (const host of ['android-x64', 'linux-riscv64', 'darwin-ppc64', 'freebsd-x64']) {
    t.is(importsTargetForHost(host), ADDON_UNAVAILABLE_TARGET, host)
  }
})

test('addon-unavailable.js names the host and the published platforms', (t) => {
  try {
    require('../../addon-unavailable.js')
    t.fail('addon-unavailable.js must throw')
  } catch (err) {
    t.ok(err.message.includes('@qvac/asr-ggml'))
    t.ok(err.message.includes(require.addon.host))
    t.ok(err.message.includes('android-arm64'))
  }
})
