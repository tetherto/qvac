import { getModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/request-context'
import { generateRandomRequestId } from '@/runtime/request-id'
import { InferenceCancelledError } from '@/errors/index'

/** Own the model until its stream and any native cancellation have drained. */
export async function* withTtsRequest<T, R>(
  request: { modelId: string; requestId?: string },
  run: (ensureActive: () => Promise<void>) => AsyncGenerator<T, R>
): AsyncGenerator<T, R> {
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateRandomRequestId(),
    kind: 'tts',
    modelId: request.modelId
  })
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
  let model: ReturnType<typeof getModel> | undefined
  const cancel = async () => {
    if (!model) return
    // Pocket's JS wrapper must also invalidate pending text and drain native
    // terminal callbacks before the next request can use this model.
    if ('cancel' in model && typeof model.cancel === 'function') {
      await (model.cancel as () => Promise<void>).call(model)
    } else if (model.addon?.cancel) {
      await model.addon.cancel()
    }
  }
  let cancellation: Promise<void> | undefined
  const onAbort = () => {
    cancellation = cancel()
    // Await and surface rejection in finally, avoiding an unhandled rejection
    // while the stream is still unwinding.
    void cancellation.catch(() => {})
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  // Call immediately after an awaited model.run*() returns. An abort may
  // have reached the addon before that startup dispatched its native job.
  const ensureActive = async () => {
    if (ctx.signal.aborted) {
      await cancel()
      throw new InferenceCancelledError(ctx.requestId)
    }
  }
  let source: AsyncGenerator<T, R> | undefined
  let completed = false
  try {
    model = getModel(request.modelId)
    source = run(ensureActive)
    for (;;) {
      if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
      const next = await source.next()
      if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
      if (next.done) {
        completed = true
        return next.value
      }
      yield next.value
    }
  } catch (error) {
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
    ctx.state = 'failed'
    throw error
  } finally {
    ctx.signal.removeEventListener('abort', onAbort)
    try {
      try {
        await cancellation
        if (!completed) {
          if (!ctx.signal.aborted && ctx.state !== 'failed') ctx.state = 'cancelled'
          await cancel()
        }
      } finally {
        await source?.return(undefined as never)
      }
    } catch (error) {
      ctx.state = 'failed'
      throw error
    }
  }
}
