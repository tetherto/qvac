'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const packageRoot = path.resolve(__dirname, '../..')
const bindingPath = path.join(packageRoot, 'binding.js')
const bindingSource = fs.readFileSync(bindingPath, 'utf8')

function loadBinding({ addon, hostAddon }) {
  const calls = { addon: 0, hostAddon: 0 }

  const fakeRequire = (specifier) => {
    assert.equal(specifier, '#host-addon')
    calls.hostAddon += 1
    return hostAddon()
  }

  fakeRequire.addon = () => {
    calls.addon += 1
    return addon()
  }

  const module_ = { exports: {} }
  const wrapper = vm.compileFunction(
    bindingSource,
    ['exports', 'require', 'module', '__filename', '__dirname'],
    { filename: bindingPath }
  )
  wrapper(module_.exports, fakeRequire, module_, bindingPath, packageRoot)

  return { exports: module_.exports, calls }
}

function nativeBinding(tag) {
  return { tag, createInstance() {}, setLogger() {}, releaseLogger() {} }
}

function packageEntry() {
  function ASRGgml() {}
  ASRGgml.resolveBackendsDir = () => ''
  return ASRGgml
}

function notCalled() {
  throw new Error('should not have been reached')
}

test('require.addon() wins when it returns the native binding', () => {
  const { exports, calls } = loadBinding({
    addon: () => nativeBinding('local-prebuild'),
    hostAddon: notCalled
  })

  assert.equal(exports.tag, 'local-prebuild')
  assert.equal(calls.hostAddon, 0)
})

test('a non-binding from require.addon() falls through to #host-addon', () => {
  const { exports, calls } = loadBinding({
    addon: packageEntry,
    hostAddon: () => nativeBinding('platform-package')
  })

  assert.equal(exports.tag, 'platform-package')
  assert.equal(calls.hostAddon, 1)
  assert.equal(typeof exports.setLogger, 'function')
})

test('a throwing require.addon() falls through to #host-addon', () => {
  const { exports } = loadBinding({
    addon: () => {
      throw new Error('no local prebuild')
    },
    hostAddon: () => nativeBinding('platform-package')
  })

  assert.equal(exports.tag, 'platform-package')
})

test('the platform-package error retains the local lookup error as cause', () => {
  const addonError = new Error('no local prebuild')

  assert.throws(
    () =>
      loadBinding({
        addon: () => {
          throw addonError
        },
        hostAddon: () => {
          throw new Error('platform package missing')
        }
      }),
    (error) => {
      assert.match(error.message, /platform package missing/)
      assert.equal(error.cause, addonError)
      return true
    }
  )
})

test('a rejected non-binding still supplies an explanatory cause', () => {
  assert.throws(
    () =>
      loadBinding({
        addon: packageEntry,
        hostAddon: () => {
          throw new Error('platform package missing')
        }
      }),
    (error) => {
      assert.match(error.cause.message, /not the native binding/)
      return true
    }
  )
})

test('a non-binding platform package is never exported', () => {
  assert.throws(
    () => loadBinding({ addon: packageEntry, hostAddon: packageEntry }),
    /#host-addon to a module that is not the native binding/
  )
})
