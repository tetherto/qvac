import { getModelEntry } from "@/server/bare/registry/model-registry";
import { getPlugin } from "@/server/plugins";
import type { PluginHandlerDefinition } from "@/schemas/plugin";
import {
  profileReplyHandler,
  profileStreamHandler,
} from "@/server/rpc/profiling";
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

function resolvePluginHandlerDef(
  modelId: string,
  handlerName: string,
): PluginHandlerDefinition {
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

  return handlerDef;
}

function resolvePluginHandler<TRequest, TResponse>(
  modelId: string,
  handlerName: string,
  request: TRequest,
): DispatchResult<TResponse> {
  const handlerDef = resolvePluginHandlerDef(modelId, handlerName);

  return {
    result: handlerDef.handler(request as never) as
      | Promise<TResponse>
      | AsyncGenerator<TResponse>,
    streaming: handlerDef.streaming,
  };
}

export async function dispatchPluginReply<TRequest, TResponse>(
  modelId: string,
  handlerName: string,
  request: TRequest,
): Promise<TResponse> {
  return profileReplyHandler({ op: handlerName, request }, async () => {
    const { result, streaming } = resolvePluginHandler<TRequest, TResponse>(
      modelId,
      handlerName,
      request,
    );

    if (streaming) {
      throw new PluginHandlerTypeMismatchError(
        handlerName,
        "reply",
        "streaming",
      );
    }

    return result as Promise<TResponse>;
  });
}

export async function* dispatchPluginStream<TRequest, TResponse>(
  modelId: string,
  handlerName: string,
  request: TRequest,
  inputStream?: AsyncIterable<Buffer>,
): AsyncGenerator<TResponse> {
  yield* profileStreamHandler({ op: handlerName, request }, async function* () {
    const handlerDef = resolvePluginHandlerDef(modelId, handlerName);

    if (inputStream) {
      if (!handlerDef.duplex) {
        throw new PluginHandlerTypeMismatchError(
          handlerName,
          "duplex",
          handlerDef.streaming ? "streaming" : "reply",
        );
      }
      yield* handlerDef.handler(
        request as never,
        inputStream,
      ) as AsyncGenerator<TResponse>;
    } else {
      if (handlerDef.duplex) {
        throw new PluginHandlerTypeMismatchError(
          handlerName,
          "streaming",
          "duplex",
        );
      }
      if (!handlerDef.streaming) {
        throw new PluginHandlerTypeMismatchError(
          handlerName,
          "streaming",
          "reply",
        );
      }
      yield* handlerDef.handler(request as never) as AsyncGenerator<TResponse>;
    }
  });
}
