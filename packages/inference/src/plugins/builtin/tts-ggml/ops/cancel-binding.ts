import { getEngineLogger } from '@/logging/index'
import { getRequestRegistry, withRequestContext } from '@/runtime/index'
import { generateRequestId } from '@/runtime/request-id'

type CancellableModel = {
  cancel?: () => Promise<void>
}

/**
 * Open the request-registry context that makes the model-scoped hard cancel
 * both TTS handlers advertise actually work, and bind its abort signal to the
 * addon's `cancel()`.
 *
 * `cancel: { scope: 'model', hard: true }` is a claim the runtime does not
 * enforce on its own: `cancelByModelId` walks the request registry, so a run
 * that never opened a context is invisible to it — a caller's `cancel()` would
 * resolve with `cancelled: 0` while the native job ran to completion. Same
 * shape as the transcription and audiogen ops.
 *
 * The returned context is an async disposable: callers must take it with
 * `await using`, and must bail out when `ctx.signal.aborted` is already true on
 * return — a queued request can resume from `begin()` already aborted, and it
 * never owned the model slot, so cancelling then would interrupt the run that
 * does.
 */
export async function bindTtsCancel(model: unknown, modelId: string, requestId?: string) {
  const ctx = await getRequestRegistry().begin({
    requestId: requestId ?? generateRequestId(),
    kind: 'tts',
    modelId
  })

  if (ctx.signal.aborted) return ctx

  const logger = withRequestContext(getEngineLogger(), ctx)
  const cancellable = model as CancellableModel

  let cancelPromise: Promise<void> | undefined
  const onAbort = () => {
    if (typeof cancellable.cancel !== 'function') return
    cancelPromise ??= cancellable.cancel().catch((error: unknown) => {
      logger.warn(
        `[cancel] model.cancel() rejected during abort for modelId=${modelId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    })
  }

  ctx.signal.addEventListener('abort', onAbort, { once: true })
  // Closes the window between the check above and the listener being attached.
  if (ctx.signal.aborted) onAbort()
  ctx.scope.defer(async () => {
    ctx.signal.removeEventListener('abort', onAbort)
    await cancelPromise
  })

  return ctx
}
