'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const packageRoot = path.resolve(__dirname, '../..')
const bindingPath = path.join(packageRoot, 'binding.js')
const publishedBindingPath = path.join(packageRoot, 'binding-published.js')
const bindingSource = fs.readFileSync(bindingPath, 'utf8')
const publishedBindingSource = fs.readFileSync(publishedBindingPath, 'utf8')

function loadBinding({ addon, hostAddon, published = false }) {
  const calls = { addon: 0, hostAddon: 0 }

  const fakeRequire = (specifier) => {
    if (specifier !== '#host-addon') {
      throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
    }
    calls.hostAddon += 1
    return hostAddon()
  }

  fakeRequire.addon = () => {
    calls.addon += 1
    return addon()
  }

  const module_ = { exports: {} }
  const source = published ? publishedBindingSource : bindingSource
  const filename = published ? publishedBindingPath : bindingPath
  const wrapper = vm.compileFunction(
    source,
    ['exports', 'require', 'module', '__filename', '__dirname'],
    { filename }
  )
  wrapper(module_.exports, fakeRequire, module_, filename, packageRoot)

  return { exports: module_.exports, calls }
}

function nativeBinding(tag) {
  return { tag, createInstance() {}, setLogger() {}, releaseLogger() {} }
}

// What `require.addon()` has been observed to return instead of the binding:
// this package's own JavaScript entry, which is the AudioGen class.
function packageEntry() {
  const AudioGen = function AudioGen() {}
  AudioGen.ENGINE_ACESTEP = 'acestep'
  AudioGen.resolveBackendsDir = () => ''
  return AudioGen
}

function notCalled() {
  throw new Error('should not have been reached')
}

test('require.addon() wins when it answers with the native binding', () => {
  const { exports, calls } = loadBinding({
    addon: () => nativeBinding('prebuild'),
    hostAddon: notCalled
  })

  assert.equal(exports.tag, 'prebuild')
  assert.equal(calls.hostAddon, 0, 'the platform package must not be consulted')
})

test('a non-binding from require.addon() falls through to the platform package', () => {
  const { exports, calls } = loadBinding({
    addon: packageEntry,
    hostAddon: () => nativeBinding('platform-package')
  })

  assert.equal(exports.tag, 'platform-package')
  assert.equal(calls.hostAddon, 1)
  assert.equal(typeof exports.createInstance, 'function')
})

test('a throwing require.addon() falls through to the platform package', () => {
  const { exports } = loadBinding({
    addon: () => {
      throw new Error('no prebuild in this package')
    },
    hostAddon: () => nativeBinding('platform-package')
  })

  assert.equal(exports.tag, 'platform-package')
})

test('the platform package error wins, carrying the addon error as its cause', () => {
  const addonError = new Error('no prebuild in this package')

  assert.throws(
    () =>
      loadBinding({
        addon: () => {
          throw addonError
        },
        hostAddon: () => {
          throw new Error('platform package is not installed')
        }
      }),
    (err) => {
      assert.match(err.message, /platform package is not installed/)
      assert.equal(err.cause, addonError)
      return true
    }
  )
})

test('a rejected require.addon() still leaves a cause on the platform error', () => {
  assert.throws(
    () =>
      loadBinding({
        addon: packageEntry,
        hostAddon: () => {
          throw new Error('platform package is not installed')
        }
      }),
    (err) => {
      assert.match(err.message, /platform package is not installed/)
      assert.notEqual(err.cause, undefined, 'every failure must explain the first source')
      assert.match(err.cause.message, /require\.addon\(\) answered with a module/)
      return true
    }
  )
})

test('a non-binding from the platform package is reported, never exported', () => {
  assert.throws(
    () => loadBinding({ addon: packageEntry, hostAddon: packageEntry }),
    (err) => {
      assert.match(err.message, /not the native binding/)
      assert.match(err.message, /createInstance/)
      return true
    }
  )
})

test('the published loader resolves the platform package without probing locally', () => {
  const { exports, calls } = loadBinding({
    published: true,
    addon: notCalled,
    hostAddon: () => nativeBinding('platform-package')
  })

  assert.equal(exports.tag, 'platform-package')
  assert.equal(calls.addon, 0)
  assert.equal(calls.hostAddon, 1)
  assert.doesNotMatch(publishedBindingSource, /\brequire\.addon\s*\(/)
})

test('the published loader preserves host package errors', () => {
  const hostError = new Error('platform package is not installed')
  assert.throws(
    () =>
      loadBinding({
        published: true,
        addon: notCalled,
        hostAddon: () => {
          throw hostError
        }
      }),
    (err) => err === hostError
  )
})

test('the published loader rejects a non-binding platform package', () => {
  assert.throws(
    () => loadBinding({ published: true, addon: notCalled, hostAddon: packageEntry }),
    /not the native binding.*createInstance/
  )
})
