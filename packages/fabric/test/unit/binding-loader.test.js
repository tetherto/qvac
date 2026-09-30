'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluate } = require('./helpers')

function loadBinding ({ addon, hostAddon }) {
  const calls = { hostAddon: 0 }
  const { exports } = evaluate('binding.js', (module_) => {
    const fakeRequire = (specifier) => {
      if (specifier !== '#host-addon') {
        throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
      }
      calls.hostAddon += 1
      return hostAddon()
    }
    fakeRequire.addon = () => addon(module_)
    return fakeRequire
  })
  return { exports, calls }
}

function nativeRuntime (tag) {
  return { tag }
}

function missingPrebuild () {
  throw new Error('no prebuild in this package')
}

// What require.addon() has been observed to return instead of the runtime: the
// package's JavaScript entry, which here is binding.js itself mid-load.
function packageEntry (module_) {
  return module_.exports
}

function notCalled () {
  throw new Error('should not have been reached')
}

test('require.addon() wins when it answers with the native runtime', () => {
  const { exports, calls } = loadBinding({
    addon: () => nativeRuntime('prebuild'),
    hostAddon: notCalled
  })

  assert.equal(exports.tag, 'prebuild')
  assert.equal(calls.hostAddon, 0, 'the platform package must not be consulted')
})

test('a throwing require.addon() falls through to the platform package', () => {
  const { exports, calls } = loadBinding({
    addon: missingPrebuild,
    hostAddon: () => nativeRuntime('platform-package')
  })

  assert.equal(exports.tag, 'platform-package')
  assert.equal(calls.hostAddon, 1)
})

test('require.addon() answering with this module falls through to the platform package', () => {
  const { exports } = loadBinding({
    addon: packageEntry,
    hostAddon: () => nativeRuntime('platform-package')
  })

  assert.equal(exports.tag, 'platform-package')
})

test('the platform package error wins, carrying the addon error as its cause', () => {
  const addonError = new Error('no prebuild in this package')

  assert.throws(
    () => loadBinding({
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

test('a self-referencing require.addon() still leaves a cause on the platform error', () => {
  assert.throws(
    () => loadBinding({
      addon: packageEntry,
      hostAddon: () => {
        throw new Error('platform package is not installed')
      }
    }),
    (err) => {
      assert.match(err.message, /platform package is not installed/)
      assert.match(err.cause.message, /JavaScript entry/)
      return true
    }
  )
})

test('a non-object from the platform package is reported, never exported', () => {
  assert.throws(
    () => loadBinding({
      addon: missingPrebuild,
      hostAddon: () => function NotTheRuntime () {}
    }),
    (err) => {
      assert.match(err.message, /not the native runtime/)
      assert.match(err.cause.message, /no prebuild in this package/)
      return true
    }
  )
})
