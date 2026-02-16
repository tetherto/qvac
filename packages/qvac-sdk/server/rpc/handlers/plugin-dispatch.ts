import { getModelEntry } from "@/server/bare/registry/model-registry";
import { getPlugin } from "@/server/plugins";
import {
  ModelNotFoundError,
  ModelIsDelegatedError,
  PluginNotFoundError,
  PluginHandlerNotFoundError,
  PluginHandlerTypeMismatchError,
} from "@/utils/errors-server";

interface DispatchResult<TResponse> {
  result: Promise<TResponse> | AsyncGenerator<TResponse>;
  streaming: boolean;
}

/**
 * Resolves the plugin handler and returns both the result and streaming flag.
 */
function resolvePluginHandler<TRequest, TResponse>(
  modelId: string,
  handlerName: string,
  request: TRequest,
): DispatchResult<TResponse> {
  const entry = getModelEntry(modelId);
  if (!entry) {
    throw new ModelNotFoundError(modelId);
  }

  if (entry.isDelegated || !entry.local) {
    throw new ModelIsDelegatedError(modelId);
  }

  const plugin = getPlugin(entry.local.modelType);
  if (!plugin) {
    throw new PluginNotFoundError(entry.local.modelType);
  }

  const handlerDef = plugin.handlers[handlerName];
  if (!handlerDef) {
    const availableHandlers = Object.keys(plugin.handlers);
    throw new PluginHandlerNotFoundError(
      entry.local.modelType,
      handlerName,
      availableHandlers,
    );
  }

  return {
    result: handlerDef.handler(request as never) as
      | Promise<TResponse>
      | AsyncGenerator<TResponse>,
    streaming: handlerDef.streaming,
  };
}

/**
 * Dispatches a request to a plugin handler and returns a Promise.
 * Use for non-streaming (reply) handlers.
 *
 * @throws PluginHandlerTypeMismatchError if the handler is streaming
 */
export async function dispatchPluginReply<TRequest, TResponse>(
  modelId: string,
  handlerName: string,
  request: TRequest,
): Promise<TResponse> {
  const { result, streaming } = resolvePluginHandler<TRequest, TResponse>(
    modelId,
    handlerName,
    request,
  );

  if (streaming) {
    throw new PluginHandlerTypeMismatchError(handlerName, "reply", "streaming");
  }

  return result as Promise<TResponse>;
}

/**
 * Dispatches a request to a plugin handler and returns an AsyncGenerator.
 * Use for streaming handlers.
 *
 * @throws PluginHandlerTypeMismatchError if the handler is not streaming
 */
export async function* dispatchPluginStream<TRequest, TResponse>(
  modelId: string,
  handlerName: string,
  request: TRequest,
): AsyncGenerator<TResponse> {
  const { result, streaming } = resolvePluginHandler<TRequest, TResponse>(
    modelId,
    handlerName,
    request,
  );

  if (!streaming) {
    throw new PluginHandlerTypeMismatchError(handlerName, "streaming", "reply");
  }

  yield* result as AsyncGenerator<TResponse>;
}
