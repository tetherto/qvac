import test from 'brittle'
import { getRequestRegistry, __resetRequestRegistrySingletonForTest } from '@/server/bare/runtime'
import { registerAddonLogger, createAddonLoggerCallback } from '@/logging'
import { resetLifecycleState } from '@/server/bare/runtime-lifecycle'
import { cleanupForTerminate, __resetWorkerCleanupForTest } from '@/server/worker-core'

// Worker cleanup must drain in-flight requests BEFORE it releases addon loggers
// / plugins: a still-draining request that logs must not route through a freed
// native logger reference. Prove it by routing a log from a request's disposal
// (which the drain awaits) and asserting the addon logger still received it.
test('worker-core: addon loggers survive until the request drain completes', async (t) => {
  // Fresh registry + lifecycle so a prior test's shutdown state can't reject the
  // begin below (a shutting-down registry admits nothing).
  __resetRequestRegistrySingletonForTest()
  resetLifecycleState()
  __resetWorkerCleanupForTest()

  const registry = getRequestRegistry()

  const logged: string[] = []
  const record = (m: string) => logged.push(m)
  const probe = { error: record, warn: record, info: record, debug: record }
  registerAddonLogger('drain-probe-model', 'drain-probe-ns', probe as never)
  const routeToAddon = createAddonLoggerCallback('drain-probe-ns')

  const ctx = await registry.begin({
    requestId: 'drain-probe-req',
    kind: 'completion',
    modelId: 'drain-probe-model'
  })
  // Runs during scope disposal; routes to `probe` only if the addon logger is
  // still registered at that point.
  ctx.scope.defer(() => {
    routeToAddon(0, 'drained')
  })

  // Simulate a handler: dispose the scope when the request is cancelled, exactly
  // like `await using ctx` unwinding. cancelAll only aborts; drainAll waits for
  // this disposal to resolve `disposed`.
  const handler = (async () => {
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) resolve()
      else ctx.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    await ctx[Symbol.asyncDispose]()
  })()

  await cleanupForTerminate()
  await handler

  t.ok(
    logged.includes('drained'),
    'the addon logger still routed while the request drained (refs alive until drain completed)'
  )

  // Restore shared process state for later tests in this suite.
  __resetWorkerCleanupForTest()
  resetLifecycleState()
  __resetRequestRegistrySingletonForTest()
})
