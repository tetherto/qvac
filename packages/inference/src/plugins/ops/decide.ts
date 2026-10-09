import { ZodError } from 'zod'
import { getModel } from '@/runtime/model-registry'
import {
  type DecideParams,
  type DecideResponse,
  decideParamsSchema,
  decideResponseSchema
} from '@/schemas/index'
import { buildUnaryResult } from '@/profiling/model-execution'
import {
  ContextOverflowError,
  DecideFailedError,
  InferenceCancelledError,
  ModelOperationNotSupportedError,
  RequestValidationFailedError
} from '@/errors/index'
import { QvacErrorBase } from '@qvac/error'
import { nowMs } from '@/profiling/index'
import { getRequestRegistry, withRequestContext } from '@/runtime/index'
import { generateRandomRequestId } from '@/runtime/request-id'
import { getEngineLogger } from '@/logging/index'

export interface DecideResult {
  answers: DecideResponse['answers']
  usage: DecideResponse['usage']
}

export async function decide(params: DecideParams, requestId?: string): Promise<DecideResult> {
  let parsed: DecideParams
  try {
    parsed = decideParamsSchema.parse(params)
  } catch (error) {
    if (error instanceof ZodError) {
      throw new RequestValidationFailedError(error.message, error)
    }
    throw error
  }
  const { modelId, state, questions, images } = parsed

  await using ctx = await getRequestRegistry().begin({
    requestId: requestId ?? generateRandomRequestId(),
    kind: 'decision',
    modelId
  })
  const requestLogger = withRequestContext(getEngineLogger(), ctx)
  const model = getModel(modelId)

  const onAbort = () => {
    const addon = model.addon
    if (addon?.cancel) {
      addon.cancel.call(addon).catch((err: unknown) => {
        requestLogger.warn(
          `[cancel] addon.cancel() rejected during abort for modelId=${modelId}: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    }
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  if (ctx.signal.aborted) onAbort()
  ctx.scope.defer(() => {
    ctx.signal.removeEventListener('abort', onAbort)
  })

  const modelStart = nowMs()
  let raw: unknown
  try {
    const response = await model.run({ state, questions, ...(images !== undefined && { images }) })
    if (ctx.signal.aborted) {
      throw new InferenceCancelledError(ctx.requestId)
    }
    raw = await response.await()
  } catch (error) {
    if (error instanceof InferenceCancelledError) throw error
    if (error instanceof ContextOverflowError) throw error
    if (error instanceof ModelOperationNotSupportedError) throw error
    if (error instanceof DecideFailedError) throw error
    if (error instanceof QvacErrorBase) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new DecideFailedError(message, error)
  }
  if (ctx.signal.aborted) {
    throw new InferenceCancelledError(ctx.requestId)
  }

  const body = decideResponseSchema.safeParse({
    type: 'decide',
    success: true,
    ...(typeof raw === 'object' && raw !== null ? raw : {})
  })
  if (!body.success) {
    throw new DecideFailedError(
      'decision addon returned a response that does not match the contract'
    )
  }

  return buildUnaryResult(
    { answers: body.data.answers, usage: body.data.usage },
    nowMs() - modelStart
  )
}
