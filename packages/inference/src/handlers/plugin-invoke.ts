import type {
  PluginInvokeRequest,
  PluginInvokeResponse,
  PluginInvokeStreamRequest,
  PluginInvokeStreamResponse
} from '@/schemas/plugin'
import { getModelEntry } from '@/runtime/model-registry'
import { getPlugin, getPluginHandler } from '@/plugins/index'
import { getRequestRegistry } from '@/runtime/index'
import { generateRandomRequestId } from '@/runtime/request-id'
import { profileReplyHandler, profileStreamHandler } from '@/profiling/index'
import {
  InferenceCancelledError,
  PluginNotFoundError,
  PluginHandlerNotFoundError,
  PluginHandlerTypeMismatchError,
  PluginRequestValidationFailedError,
  PluginResponseValidationFailedError,
  ModelNotFoundError
} from '@/errors/index'
import { getEngineLogger } from '@/logging/index'
import { formatZodError } from '@/utils/zod-error'

const logger = getEngineLogger()

function resolvePluginHandler(modelId: string, handlerName: string) {
  const modelEntry = getModelEntry(modelId)
  if (!modelEntry) {
    throw new ModelNotFoundError(modelId)
  }

  const modelType = modelEntry.local.modelType
  const plugin = getPlugin(modelType)
  if (!plugin) {
    throw new PluginNotFoundError(modelType)
  }

  const handlerDef = getPluginHandler(modelType, handlerName)
  if (!handlerDef) {
    const availableHandlers = Object.keys(plugin.handlers)
    throw new PluginHandlerNotFoundError(modelType, handlerName, availableHandlers)
  }

  return { modelType, plugin, handlerDef }
}

// Every invoke is a registry request of kind `plugin` on the model, so a
// caller can cancel it by id and a session close or model unload sweeps it.
// The handler receives the abort signal through its context argument.
function beginInvoke(request: PluginInvokeRequest | PluginInvokeStreamRequest) {
  return getRequestRegistry().begin({
    requestId: request.requestId ?? generateRandomRequestId(),
    sessionId: request.sessionId,
    kind: 'plugin',
    modelId: request.modelId
  })
}

export async function handlePluginInvoke(
  request: PluginInvokeRequest
): Promise<PluginInvokeResponse> {
  return profileReplyHandler({ op: 'pluginInvoke', request }, async () => {
    const { modelId, handler: handlerName, params } = request

    logger.debug(`[pluginInvoke] modelId=${modelId} handler=${handlerName}`)

    const { handlerDef } = resolvePluginHandler(modelId, handlerName)

    if (handlerDef.streaming) {
      throw new PluginHandlerTypeMismatchError(handlerName, 'reply', 'streaming')
    }

    const parseResult = handlerDef.requestSchema.safeParse(params)
    if (!parseResult.success) {
      throw new PluginRequestValidationFailedError(handlerName, formatZodError(parseResult.error))
    }

    await using ctx = await beginInvoke(request)
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)

    const result = await handlerDef.handler(parseResult.data, undefined, { signal: ctx.signal })
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)

    const responseParseResult = handlerDef.responseSchema.safeParse(result)
    if (!responseParseResult.success) {
      throw new PluginResponseValidationFailedError(
        handlerName,
        formatZodError(responseParseResult.error)
      )
    }

    return {
      type: 'pluginInvoke' as const,
      requestId: ctx.requestId,
      result: responseParseResult.data
    }
  })
}

export async function* handlePluginInvokeStream(
  request: PluginInvokeStreamRequest
): AsyncGenerator<PluginInvokeStreamResponse> {
  yield* profileStreamHandler({ op: 'pluginInvokeStream', request }, async function* () {
    const { modelId, handler: handlerName, params } = request

    logger.debug(`[pluginInvokeStream] modelId=${modelId} handler=${handlerName}`)

    const { handlerDef } = resolvePluginHandler(modelId, handlerName)

    if (!handlerDef.streaming) {
      throw new PluginHandlerTypeMismatchError(handlerName, 'streaming', 'reply')
    }

    const parseResult = handlerDef.requestSchema.safeParse(params)
    if (!parseResult.success) {
      throw new PluginRequestValidationFailedError(handlerName, formatZodError(parseResult.error))
    }

    await using ctx = await beginInvoke(request)
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)

    const generator = handlerDef.handler(parseResult.data, undefined, {
      signal: ctx.signal
    }) as AsyncGenerator<unknown>

    for await (const chunk of generator) {
      if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
      const responseParseResult = handlerDef.responseSchema.safeParse(chunk)
      if (!responseParseResult.success) {
        throw new PluginResponseValidationFailedError(
          handlerName,
          formatZodError(responseParseResult.error)
        )
      }

      yield {
        type: 'pluginInvokeStream' as const,
        result: responseParseResult.data,
        done: false
      }
    }
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)

    yield {
      type: 'pluginInvokeStream' as const,
      requestId: ctx.requestId,
      result: null,
      done: true
    }
  })
}
