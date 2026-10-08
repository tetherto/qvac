import { getModel } from '@/runtime/model-registry'
import { getRequestRegistry, withRequestContext } from '@/runtime/request-context'
import { generateRandomRequestId } from '@/runtime/request-id'
import { InferenceCancelledError, InvalidResponseError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'
import { nowMs } from '@/profiling/index'
import { attachModelExecutionMs } from '@/profiling/model-execution'
import {
  layaRequestSchema,
  layaResultSchema,
  type DecideRequest,
  type LayaResponse
} from '@/schemas/index'
import { transformDecisionsRequest } from '@/plugins/builtin/llamacpp-decisions/helpers'
import type { LayaDecisions } from '@qvac/embed-llamacpp'

export async function decide(request: DecideRequest) {
  const { modelId, requestId, type: _type, ...input } = request
  const nativeRequest = transformDecisionsRequest(layaRequestSchema.parse(input))
  await using ctx = await getRequestRegistry().begin({
    requestId: requestId ?? generateRandomRequestId(),
    kind: 'decisions',
    modelId
  })
  const requestLogger = withRequestContext(getEngineLogger(), ctx)
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
  const model = getModel(modelId) as unknown as LayaDecisions
  const onAbort = () => {
    model.cancel().catch((error: unknown) => {
      requestLogger.warn(
        `Laya cancel failed: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  ctx.scope.defer(() => ctx.signal.removeEventListener('abort', onAbort))

  const started = nowMs()
  try {
    const response = await model.run(nativeRequest)
    const outputs = await response.await()
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
    if (outputs.length !== 1) throw new InvalidResponseError('decide')
    const parsed = (
      'states' in nativeRequest ? layaResultSchema.array() : layaResultSchema
    ).safeParse(outputs[0])
    if (!parsed.success) throw new InvalidResponseError('decide', parsed.error)
    const result: LayaResponse = parsed.data
    if (
      'states' in nativeRequest &&
      (!Array.isArray(result) || result.length !== nativeRequest.states.length)
    ) {
      throw new InvalidResponseError('decide')
    }
    return attachModelExecutionMs({ type: 'decide' as const, result }, nowMs() - started)
  } catch (error) {
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
    ctx.state = 'failed'
    throw error
  }
}
