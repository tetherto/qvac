import { getModel } from '@/runtime/model-registry'
import { getRequestRegistry, withRequestContext } from '@/runtime/request-context'
import { generateRandomRequestId } from '@/runtime/request-id'
import {
  InferenceCancelledError,
  InvalidResponseError,
  RequestValidationFailedError
} from '@/errors/index'
import { getEngineLogger } from '@/logging/index'
import { nowMs } from '@/profiling/index'
import { attachModelExecutionMs } from '@/profiling/model-execution'
import { decisionResultSchema, type DecideRequest, type DecisionResponse } from '@/schemas/index'
import {
  fromUpstreamResult,
  isInvalidRequestError,
  toUpstreamRequest,
  type DecisionModel,
  type UpstreamResult
} from '@/plugins/builtin/llamacpp-decision/upstream'

// One engine run per call. A batch goes as `states`: the engine sends them to
// upstream concurrently, so its slots batch them, and returns the results in
// input order. The first failing state or a cancel fails the whole call.
export async function decide(request: DecideRequest) {
  const { modelId, requestId } = request
  const model = getModel(modelId) as unknown as DecisionModel
  const info = model.info
  if (!info) throw new InvalidResponseError('decide')
  const batch = 'states' in request
  const states = batch ? request.states : [request.state]
  // Validate and convert before the run. The questions, and so the key maps,
  // are the same for every state.
  const { body: single, keyMaps } = toUpstreamRequest(request, states[0]!, info)

  await using ctx = await getRequestRegistry().begin({
    requestId: requestId ?? generateRandomRequestId(),
    kind: 'decision',
    modelId
  })
  const requestLogger = withRequestContext(getEngineLogger(), ctx)
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
  let cancelPromise: Promise<void> | undefined
  const onAbort = () => {
    cancelPromise ??= model.cancel().catch((error: unknown) => {
      requestLogger.warn(
        `Decision cancel failed: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  ctx.scope.defer(async () => {
    ctx.signal.removeEventListener('abort', onAbort)
    await cancelPromise
  })

  const started = nowMs()
  try {
    let native: unknown
    try {
      if (batch) {
        const outputs = await (
          await model.engine.run({ states, questions: single.questions })
        ).await()
        if (outputs.length !== 1) throw new InvalidResponseError('decide')
        native = outputs[0]
      } else {
        const outputs = await (await model.engine.run(single)).await()
        if (outputs.length !== 1) throw new InvalidResponseError('decide')
        native = [outputs[0]]
      }
    } catch (error) {
      if (isInvalidRequestError(error)) {
        throw new RequestValidationFailedError(error.message, error)
      }
      throw error
    }
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
    if (!Array.isArray(native) || native.length !== states.length) {
      throw new InvalidResponseError('decide')
    }
    let results
    try {
      results = native.map((output: UpstreamResult) =>
        decisionResultSchema.parse(fromUpstreamResult(output, keyMaps))
      )
    } catch (error) {
      throw new InvalidResponseError('decide', error)
    }
    const result: DecisionResponse = batch ? results : results[0]!
    return attachModelExecutionMs({ type: 'decide' as const, result }, nowMs() - started)
  } catch (error) {
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
    ctx.state = 'failed'
    throw error
  }
}
