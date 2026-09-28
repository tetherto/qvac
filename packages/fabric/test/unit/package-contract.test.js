'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluate } = require('./helpers')
const { PREBUILT_HOSTS, hostPlatformPackage } = require('../../backends.js')
const packageJson = require('../../package.json')

const ADDON_UNAVAILABLE = './addon-unavailable.js'

// Walk the conditional map the way Bare does: the first key that is `default`
// or one of the host's platform/arch conditions wins, recursively.
function importsTargetsForHost (host) {
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

function loadUnavailable (host) {
  try {
    evaluate('addon-unavailable.js', () => {
      const fakeRequire = (specifier) => require('../../' + specifier.replace('./', ''))
      fakeRequire.addon = { host }
      return fakeRequire
    })
  } catch (err) {
    return err
  }
  throw new Error('addon-unavailable.js must throw on load')
}

test('the imports map routes every published host to its platform package', () => {
  for (const host of PREBUILT_HOSTS) {
    const targets = importsTargetsForHost(host)
    assert.equal(targets[0], hostPlatformPackage(host), host)
    assert.equal(targets[targets.length - 1], ADDON_UNAVAILABLE, host)
  }
})

test('the imports map routes unpublished hosts to the actionable error', () => {
  for (const host of ['android-x64', 'android-arm', 'linux-riscv64', 'darwin-ppc64', 'freebsd-x64']) {
    assert.deepEqual(importsTargetsForHost(host), [ADDON_UNAVAILABLE], host)
  }
})

test('optionalDependencies are injected at publish, not declared in the source manifest', () => {
  assert.equal(packageJson.optionalDependencies, undefined)
})

test('the meta package publishes the loader, the helper, and the C++ SDK', () => {
  for (const file of ['binding.js', 'addon-unavailable.js', 'backends.js', 'backends.d.ts']) {
    assert.ok(packageJson.files.includes(file), file)
  }
  for (const dir of ['prebuilds/include', 'prebuilds/share/qvac-fabric']) {
    assert.ok(packageJson.files.includes(dir), dir)
  }
  assert.equal(packageJson.addon, true, 'the SDK linker only reads #host-addon from addons')
  assert.deepEqual(packageJson.exports['./backends'], {
    types: './backends.d.ts',
    default: './backends.js'
  })
})

test('a missing desktop slice names the package and the optional-dependency cause', () => {
  const err = loadUnavailable('linux-x64')
  assert.match(err.message, /@qvac\/fabric-linux-x64 is not installed/)
  assert.match(err.message, /--omit=optional/)
})

test('a missing mobile slice asks for an exact-version direct dependency', () => {
  for (const [host, expected] of [['android-arm64', 'android-arm64'], ['ios-arm64-simulator', 'ios']]) {
    const err = loadUnavailable(host)
    assert.match(err.message, new RegExp(`@qvac/fabric-${expected} is not installed`), host)
    assert.match(err.message, /direct dependency pinned to the exact/, host)
  }
})

test('an unpublished host is told to build from source', () => {
  const err = loadUnavailable('linux-riscv64')
  assert.match(err.message, /no prebuilt runtime for host linux-riscv64/)
  assert.match(err.message, /bare-make/)
})
