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
  transformDecisionRequest,
  transformDecisionResult
} from '@/plugins/builtin/llamacpp-decision/helpers'
import {
  fromUpstreamResult,
  isInvalidRequestError,
  toUpstreamRequest,
  type DecisionModel
} from '@/plugins/builtin/llamacpp-decision/upstream'
import type { LayaDecisions } from '@qvac/embed-llamacpp'

export async function decide(request: DecideRequest) {
  const { modelId } = request
  const loaded = getModel(modelId) as unknown as Partial<DecisionModel>
  if (loaded.kind === 'upstream') return decideUpstream(request, loaded as DecisionModel)
  return decideLaya(request)
}

// Upstream engines answer one state per run. States run in input order; the
// first failure or a cancel fails the whole call, as on the Laya path.
async function decideUpstream(request: DecideRequest, model: DecisionModel) {
  const { modelId, requestId } = request
  const info = model.info
  if (!info) throw new InvalidResponseError('decide')
  const states = 'states' in request ? request.states : [request.state]
  // Validate and convert every state before any runs.
  const runs = states.map((state) => toUpstreamRequest(request, state, info))

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
    const results = []
    for (const { body, keyMaps } of runs) {
      if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
      let outputs
      try {
        outputs = await (await model.upstream.run(body)).await()
      } catch (error) {
        if (isInvalidRequestError(error)) {
          throw new RequestValidationFailedError(error.message, error)
        }
        throw error
      }
      if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
      if (outputs.length !== 1) throw new InvalidResponseError('decide')
      try {
        results.push(decisionResultSchema.parse(fromUpstreamResult(outputs[0]!, keyMaps)))
      } catch (error) {
        throw new InvalidResponseError('decide', error)
      }
    }
    const result: DecisionResponse = 'states' in request ? results : results[0]!
    return attachModelExecutionMs({ type: 'decide' as const, result }, nowMs() - started)
  } catch (error) {
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
    ctx.state = 'failed'
    throw error
  }
}

async function decideLaya(request: DecideRequest) {
  const { modelId, requestId } = request
  const nativeRequest = transformDecisionRequest(request)
  await using ctx = await getRequestRegistry().begin({
    requestId: requestId ?? generateRandomRequestId(),
    kind: 'decision',
    modelId
  })
  const requestLogger = withRequestContext(getEngineLogger(), ctx)
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
  const model = getModel(modelId) as unknown as LayaDecisions
  let cancelPromise: Promise<void> | undefined
  const onAbort = () => {
    cancelPromise ??= model.cancel().catch((error: unknown) => {
      requestLogger.warn(
        `Laya cancel failed: ${error instanceof Error ? error.message : String(error)}`
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
    const response = await model.run(nativeRequest)
    const outputs = await response.await()
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
    if (outputs.length !== 1) throw new InvalidResponseError('decide')
    let result: DecisionResponse
    try {
      const output = outputs[0]!
      const converted = Array.isArray(output)
        ? output.map(transformDecisionResult)
        : transformDecisionResult(output)
      result = (
        'states' in nativeRequest ? decisionResultSchema.array() : decisionResultSchema
      ).parse(converted)
    } catch (error) {
      throw new InvalidResponseError('decide', error)
    }
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
