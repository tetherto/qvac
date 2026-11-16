import test from 'brittle'
import { createDisposableScope } from '@/runtime/disposable-scope'
import { defineDisposeSymbols } from '@/runtime/dispose-symbols'
import { AsyncDisposeUnavailableError } from '@/errors/index'

// -----------------------------------------------------------------------------
// DisposableScope unit tests.
//
// Covers the four contracts handlers will rely on:
//   1. LIFO cleanup ordering (mirrors how try/finally would unwind a
//      sequential write-up of the same handler).
//   2. Idempotent dispose — a scope that has already unwound is a no-op
//      on subsequent dispose calls.
//   3. Error aggregation — every cleanup runs even when an earlier one
//      throws; multiple failures arrive as a single AggregateError.
//   4. Late-defer behaviour — calling defer after dispose runs the
//      cleanup eagerly so resources don't leak silently.
// -----------------------------------------------------------------------------

test('dispose-symbols: an engine without the symbols gets the ones esbuild falls back to', (t) => {
  const symbol = { for: Symbol.for } as unknown as SymbolConstructor
  defineDisposeSymbols(symbol)

  t.is(symbol.asyncDispose, Symbol.for('Symbol.asyncDispose'))
  t.is(symbol.dispose, Symbol.for('Symbol.dispose'))
})

test("dispose-symbols: an engine's own symbols are kept", (t) => {
  const own = { for: Symbol.for, asyncDispose: Symbol('own'), dispose: Symbol('own') }
  const before = [own.asyncDispose, own.dispose]
  defineDisposeSymbols(own as unknown as SymbolConstructor)

  t.alike([own.asyncDispose, own.dispose], before)
})

test('dispose-symbols: an engine where they cannot be defined fails with ASYNC_DISPOSE_UNAVAILABLE', (t) => {
  const frozen = Object.freeze({ for: Symbol.for }) as unknown as SymbolConstructor

  t.exception(() => defineDisposeSymbols(frozen), AsyncDisposeUnavailableError)
})
test('disposable-scope: cleanups run in LIFO order', async (t) => {
  const order: string[] = []
  const scope = createDisposableScope()
  scope.defer(() => {
    order.push('first-registered')
  })
  scope.defer(() => {
    order.push('second-registered')
  })
  scope.defer(async () => {
    await Promise.resolve()
    order.push('third-registered')
  })

  await scope[Symbol.asyncDispose]()
  t.alike(order, ['third-registered', 'second-registered', 'first-registered'])
  t.is(scope.disposed, true)
})

test('disposable-scope: dispose is idempotent', async (t) => {
  let runs = 0
  const scope = createDisposableScope()
  scope.defer(() => {
    runs++
  })
  await scope[Symbol.asyncDispose]()
  await scope[Symbol.asyncDispose]()
  await scope[Symbol.asyncDispose]()
  t.is(runs, 1, 'deferred cleanup runs exactly once')
  t.is(scope.disposed, true)
})

test('disposable-scope: a single failing cleanup rethrows verbatim', async (t) => {
  const scope = createDisposableScope()
  const boom = new Error('boom')
  scope.defer(() => {
    throw boom
  })
  await t.exception(async () => {
    await scope[Symbol.asyncDispose]()
  })
})

test('disposable-scope: multiple failures are collected into AggregateError', async (t) => {
  const scope = createDisposableScope()
  let third = 0
  scope.defer(() => {
    throw new Error('first')
  })
  scope.defer(() => {
    third++
  })
  scope.defer(async () => {
    await Promise.resolve()
    throw new Error('second')
  })

  let captured: unknown = null
  try {
    await scope[Symbol.asyncDispose]()
  } catch (err) {
    captured = err
  }

  t.ok(captured instanceof AggregateError, 'throws AggregateError')
  const agg = captured as AggregateError
  t.is(agg.errors.length, 2, 'two underlying errors')
  t.is(third, 1, 'non-throwing cleanup still runs')
})

test('disposable-scope: every cleanup runs even when one throws midway', async (t) => {
  const scope = createDisposableScope()
  let aRan = 0
  let cRan = 0
  scope.defer(() => {
    aRan++
  })
  scope.defer(() => {
    throw new Error('middle')
  })
  scope.defer(() => {
    cRan++
  })
  try {
    await scope[Symbol.asyncDispose]()
  } catch {
    // expected
  }
  t.is(aRan, 1, 'earlier-registered cleanup ran despite later throw')
  t.is(cRan, 1, 'later-registered cleanup ran first (LIFO) and unaffected')
})

test('disposable-scope: late defer runs the cleanup eagerly', async (t) => {
  const scope = createDisposableScope()
  await scope[Symbol.asyncDispose]()
  t.is(scope.disposed, true)

  let lateRan = 0
  scope.defer(() => {
    lateRan++
  })
  // Eager run is synchronous-or-microtask; yielding once is enough.
  await Promise.resolve()
  await Promise.resolve()
  t.is(lateRan, 1, 'late-registered cleanup ran without leaking')
})

test('disposable-scope: works with `await using` syntax', async (t) => {
  const seen: string[] = []
  async function run() {
    await using scope = createDisposableScope()
    scope.defer(() => {
      seen.push('a')
    })
    scope.defer(() => {
      seen.push('b')
    })
    seen.push('body')
  }
  await run()
  t.alike(seen, ['body', 'b', 'a'], 'await using disposes in LIFO order')
})
