import { getModel } from '@/runtime/model-registry'
import { getRequestRegistry, withRequestContext } from '@/runtime/request-context'
import { generateRandomRequestId } from '@/runtime/request-id'
import { InferenceCancelledError, InvalidResponseError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'
import { nowMs } from '@/profiling/index'
import { attachModelExecutionMs } from '@/profiling/model-execution'
import { rerankScoresSchema, type RerankRequest } from '@/schemas/index'
import type { Reranker } from '@qvac/embed-llamacpp'

export async function rerank(request: RerankRequest) {
  const { modelId, requestId, query, documents } = request
  await using ctx = await getRequestRegistry().begin({
    requestId: requestId ?? generateRandomRequestId(),
    kind: 'rerank',
    modelId
  })
  const requestLogger = withRequestContext(getEngineLogger(), ctx)
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
  const model = getModel(modelId) as unknown as Reranker
  let cancelPromise: Promise<void> | undefined
  const onAbort = () => {
    cancelPromise ??= model.cancel().catch((error: unknown) => {
      requestLogger.warn(
        `Reranker cancel failed: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  ctx.scope.defer(async () => {
    ctx.signal.removeEventListener('abort', onAbort)
    // A delayed native cancel must finish before the next job owns this model slot.
    await cancelPromise
  })

  const started = nowMs()
  try {
    const response = await model.run({ query, documents })
    const outputs = await response.await()
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
    if (outputs.length !== 1) throw new InvalidResponseError('rerank')
    const parsed = rerankScoresSchema.safeParse(outputs[0])
    if (!parsed.success) throw new InvalidResponseError('rerank', parsed.error)
    if (parsed.data.length !== documents.length) throw new InvalidResponseError('rerank')
    return attachModelExecutionMs(
      { type: 'rerank' as const, scores: parsed.data },
      nowMs() - started
    )
  } catch (error) {
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
    ctx.state = 'failed'
    throw error
  }
}
