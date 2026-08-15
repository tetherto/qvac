import test from 'brittle'
import { createRequestRegistry } from '@/server/bare/runtime'
import { drainRequestsThenReleaseAddons } from '@/server/bare/runtime/shutdown-drain'

// Worker cleanup must drain in-flight requests BEFORE it releases addon loggers
// / plugins: a still-draining request that logs must not route through a freed
// native logger reference. Prove the ordering contract directly on an injected
// registry, so nothing touches the process-wide singleton.
test('worker-core: addon loggers are released only after the request drain completes', async (t) => {
  const registry = createRequestRegistry()
  const order: string[] = []

  const ctx = await registry.begin({
    requestId: 'drain-probe-req',
    kind: 'completion',
    modelId: 'drain-probe-model'
  })
  // Runs during scope disposal, which drainAll() awaits.
  ctx.scope.defer(() => {
    order.push('drained')
  })

  // A handler that disposes the scope when the request is cancelled, exactly
  // like `await using ctx` unwinding: cancelAll aborts, drainAll waits for this.
  const handler = (async () => {
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) resolve()
      else ctx.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    await ctx[Symbol.asyncDispose]()
  })()

  await drainRequestsThenReleaseAddons(registry, () => order.push('released'))
  await handler

  t.alike(
    order,
    ['drained', 'released'],
    'addon loggers/plugins are released only after the request drained'
  )
})
