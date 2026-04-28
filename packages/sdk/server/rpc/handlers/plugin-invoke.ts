import type {
  PluginInvokeRequest,
  PluginInvokeResponse,
  PluginInvokeStreamRequest,
  PluginInvokeStreamResponse,
} from "@/schemas/plugin";
import { getModelEntry } from "@/server/bare/registry/model-registry";
import { getPlugin, getPluginHandler } from "@/server/plugins";
import {
  profileReplyHandler,
  profileStreamHandler,
} from "@/server/rpc/profiling";
import {
  PluginNotFoundError,
  PluginHandlerNotFoundError,
  PluginHandlerTypeMismatchError,
  PluginRequestValidationFailedError,
  PluginResponseValidationFailedError,
  ModelIsDelegatedError,
  ModelNotFoundError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

function resolvePluginHandler(modelId: string, handlerName: string) {
  const modelEntry = getModelEntry(modelId);
  if (!modelEntry) {
    throw new ModelNotFoundError(modelId);
  }
  if (modelEntry.isDelegated) {
    throw new ModelIsDelegatedError(modelId);
  }

  const modelType = modelEntry.local.modelType;
  const plugin = getPlugin(modelType);
  if (!plugin) {
    throw new PluginNotFoundError(modelType);
  }

  const handlerDef = getPluginHandler(modelType, handlerName);
  if (!handlerDef) {
    const availableHandlers = Object.keys(plugin.handlers);
    throw new PluginHandlerNotFoundError(
      modelType,
      handlerName,
      availableHandlers,
    );
  }

  return { modelType, plugin, handlerDef };
}

export async function handlePluginInvoke(
  request: PluginInvokeRequest,
): Promise<PluginInvokeResponse> {
  return profileReplyHandler({ op: "pluginInvoke", request }, async () => {
    const { modelId, handler: handlerName, params } = request;

    logger.debug(`[pluginInvoke] modelId=${modelId} handler=${handlerName}`);

    const { handlerDef } = resolvePluginHandler(modelId, handlerName);

    if (handlerDef.streaming) {
      throw new PluginHandlerTypeMismatchError(
        handlerName,
        "reply",
        "streaming",
      );
    }

    const parseResult = handlerDef.requestSchema.safeParse(params);
    if (!parseResult.success) {
      const details = parseResult.error.issues
        .map((i) => `${String(i.path.join("."))}: ${i.message}`)
        .join(", ");
      throw new PluginRequestValidationFailedError(handlerName, details);
    }

    const result = await handlerDef.handler(parseResult.data);

    const responseParseResult = handlerDef.responseSchema.safeParse(result);
    if (!responseParseResult.success) {
      const details = responseParseResult.error.issues
        .map((i) => `${String(i.path.join("."))}: ${i.message}`)
        .join(", ");
      throw new PluginResponseValidationFailedError(handlerName, details);
    }

    return {
      type: "pluginInvoke" as const,
      result: responseParseResult.data,
    };
  });
}

export async function* handlePluginInvokeStream(
  request: PluginInvokeStreamRequest,
): AsyncGenerator<PluginInvokeStreamResponse> {
  yield* profileStreamHandler(
    { op: "pluginInvokeStream", request },
    async function* () {
      const { modelId, handler: handlerName, params } = request;

      logger.debug(
        `[pluginInvokeStream] modelId=${modelId} handler=${handlerName}`,
      );

      const { handlerDef } = resolvePluginHandler(modelId, handlerName);

      if (!handlerDef.streaming) {
        throw new PluginHandlerTypeMismatchError(
          handlerName,
          "streaming",
          "reply",
        );
      }

      const parseResult = handlerDef.requestSchema.safeParse(params);
      if (!parseResult.success) {
        const details = parseResult.error.issues
          .map((i) => `${String(i.path.join("."))}: ${i.message}`)
          .join(", ");
        throw new PluginRequestValidationFailedError(handlerName, details);
      }

      const generator = handlerDef.handler(
        parseResult.data,
      ) as AsyncGenerator<unknown>;

      for await (const chunk of generator) {
        const responseParseResult = handlerDef.responseSchema.safeParse(chunk);
        if (!responseParseResult.success) {
          const details = responseParseResult.error.issues
            .map((i) => `${String(i.path.join("."))}: ${i.message}`)
            .join(", ");
          throw new PluginResponseValidationFailedError(handlerName, details);
        }

        yield {
          type: "pluginInvokeStream" as const,
          result: responseParseResult.data,
          done: false,
        };
      }

      yield {
        type: "pluginInvokeStream" as const,
        result: null,
        done: true,
      };
    },
  );
}
