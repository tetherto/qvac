'use strict'

// Node unit tests for the co-load core (no Bare, no device, no real addon).
// Run with: npm run test:unit  (node --test)

const { test } = require('node:test')
const assert = require('node:assert')

const {
  isMissingModuleError,
  coloadOnce,
  runLifecycle,
  lifecycleTargets
} = require('../coload.js')

function makeSink () {
  const oks = []
  const fails = []
  const cycles = []
  return {
    ok: (name, specifier, origin) => oks.push({ name, origin }),
    fail: (name, specifier, err) => fails.push({ name, message: String((err && err.message) || err) }),
    cycle: (name, cycle) => cycles.push({ name, cycle }),
    oks,
    fails,
    cycles
  }
}

function missingModule (specifier) {
  const err = new Error(`Cannot find module '${specifier}'`)
  err.code = 'MODULE_NOT_FOUND'
  return err
}

function fakeAddonClass (log, name, opts = {}) {
  const disposeName = opts.disposeName || 'destroy'
  function Fake (...args) {
    log.push(`new:${name}`)
    this.args = args
  }
  Fake.prototype[disposeName] = function () {
    log.push(`dispose:${name}`)
    if (opts.disposeThrows) throw new Error(`dispose ${name} boom`)
  }
  return Fake
}

test('isMissingModuleError classifies only missing-module errors', () => {
  assert.strictEqual(isMissingModuleError(missingModule('@qvac/tts-ggml')), true)
  assert.strictEqual(isMissingModuleError(new Error("Cannot find package '@qvac/tts-ggml'")), true)
  assert.strictEqual(isMissingModuleError(new Error('undefined symbol: ggml_backend_is_cpu')), false)
})

test('coloadOnce loads every installed addon and reports origin', () => {
  const addons = {
    a: { specifier: '@qvac/a' },
    b: { specifier: '@qvac/b' }
  }
  const deps = {
    addons,
    requireFn: () => ({}),
    sourcePathOf: name => name,
    requireInstalled: true
  }
  const sink = makeSink()
  const loaded = coloadOnce(deps, ['a', 'b'], sink)
  assert.deepStrictEqual(loaded.map(e => e.ok), [true, true])
  assert.deepStrictEqual(sink.oks.map(o => o.origin), ['installed', 'installed'])
  assert.strictEqual(sink.fails.length, 0)
})

test('coloadOnce falls back to source only when install is not required', () => {
  const deps = {
    addons: { a: { specifier: '@qvac/a' } },
    requireFn: specifier => {
      if (specifier.startsWith('@qvac/')) throw missingModule(specifier)
      return { fromSource: true }
    },
    sourcePathOf: name => `/repo/packages/${name}`,
    requireInstalled: false
  }
  const sink = makeSink()
  const loaded = coloadOnce(deps, ['a'], sink)
  assert.strictEqual(loaded[0].ok, true)
  assert.strictEqual(loaded[0].origin, 'source')
  assert.strictEqual(sink.oks[0].origin, 'source')
})

test('coloadOnce refuses the source fallback (false-green guard) when install is required', () => {
  const deps = {
    addons: { a: { specifier: '@qvac/a' } },
    requireFn: specifier => { throw missingModule(specifier) },
    sourcePathOf: name => `/repo/packages/${name}`,
    requireInstalled: true
  }
  const sink = makeSink()
  const loaded = coloadOnce(deps, ['a'], sink)
  assert.strictEqual(loaded[0].ok, false)
  assert.strictEqual(sink.fails.length, 1)
  assert.match(sink.fails[0].message, /COLOAD_REQUIRE_INSTALLED/)
})

test('coloadOnce never swallows a non-missing (dlopen/symbol) failure', () => {
  const deps = {
    addons: { a: { specifier: '@qvac/a' } },
    requireFn: () => { throw new Error('undefined symbol: ggml_backend_is_cpu') },
    sourcePathOf: name => name,
    requireInstalled: false
  }
  const sink = makeSink()
  const loaded = coloadOnce(deps, ['a'], sink)
  assert.strictEqual(loaded[0].ok, false)
  assert.match(sink.fails[0].message, /ggml_backend_is_cpu/)
})

test('coloadOnce treats a null export as a failure', () => {
  const deps = {
    addons: { a: { specifier: '@qvac/a' } },
    requireFn: () => null,
    sourcePathOf: name => name,
    requireInstalled: true
  }
  const sink = makeSink()
  const loaded = coloadOnce(deps, ['a'], sink)
  assert.strictEqual(loaded[0].ok, false)
  assert.match(sink.fails[0].message, /null\/undefined/)
})

test('runLifecycle interleaves construct+dispose across opted-in addons per cycle', () => {
  const log = []
  const mods = {
    '@qvac/a': fakeAddonClass(log, 'a'),
    '@qvac/b': fakeAddonClass(log, 'b'),
    '@qvac/c': {}
  }
  const deps = {
    addons: {
      a: { specifier: '@qvac/a', lifecycle: { dispose: 'destroy' } },
      b: { specifier: '@qvac/b', lifecycle: { dispose: 'destroy' } },
      c: { specifier: '@qvac/c' }
    },
    requireFn: specifier => mods[specifier],
    sourcePathOf: name => name,
    requireInstalled: true
  }
  const sink = makeSink()
  const loaded = coloadOnce(deps, ['a', 'b', 'c'], sink)

  assert.deepStrictEqual(lifecycleTargets(deps, loaded).map(e => e.name), ['a', 'b'])

  const exercised = runLifecycle(deps, loaded, 2, sink)
  assert.deepStrictEqual(exercised.map(e => e.name), ['a', 'b'])
  assert.deepStrictEqual(log, [
    'new:a', 'dispose:a', 'new:b', 'dispose:b',
    'new:a', 'dispose:a', 'new:b', 'dispose:b'
  ])
  assert.strictEqual(sink.cycles.length, 4)
  assert.strictEqual(sink.fails.length, 0)
})

test('runLifecycle records a dispose failure without throwing', () => {
  const log = []
  const deps = {
    addons: { a: { specifier: '@qvac/a', lifecycle: { dispose: 'destroy' } } },
    requireFn: () => fakeAddonClass(log, 'a', { disposeThrows: true }),
    sourcePathOf: name => name,
    requireInstalled: true
  }
  const sink = makeSink()
  const loaded = coloadOnce(deps, ['a'], sink)
  assert.doesNotThrow(() => runLifecycle(deps, loaded, 1, sink))
  assert.strictEqual(sink.fails.length, 1)
  assert.match(sink.fails[0].message, /boom/)
})

test('runLifecycle is a no-op when no addon opts in or cycles < 1', () => {
  const deps = {
    addons: { a: { specifier: '@qvac/a' } },
    requireFn: () => ({}),
    sourcePathOf: name => name,
    requireInstalled: true
  }
  const sink = makeSink()
  const loaded = coloadOnce(deps, ['a'], sink)
  assert.deepStrictEqual(runLifecycle(deps, loaded, 5, sink), [])
  assert.strictEqual(sink.cycles.length, 0)
})
