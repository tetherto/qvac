import type { AbortSignal } from 'bare-abort-controller'
import { getEngineLogger } from '@/logging/index'
import { getRequestRegistry, withRequestContext } from '@/runtime/index'
import { generateRequestId } from '@/runtime/request-id'

type CancellableModel = {
  cancel?: () => Promise<void>
}

/**
 * The abort is persistent state, not a one-shot poke. The addon's `cancel()`
 * only reaches a native job that is live at that instant, and every chunked
 * path (`stream: true`, `sentenceStream`, the duplex session) runs one native
 * job per sentence — so a cancel that lands between two jobs is a native
 * no-op and synthesis would carry on. Ops call this on every chunk: once the
 * signal is aborted it re-issues the cancel (the next job is live by then),
 * and returns true so the caller drops the output instead of forwarding it.
 */
export async function cancelIfAborted(model: unknown, signal: AbortSignal): Promise<boolean> {
  if (!signal.aborted) return false
  const cancellable = model as CancellableModel
  if (typeof cancellable.cancel === 'function') {
    await cancellable.cancel().catch(() => {})
  }
  return true
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
