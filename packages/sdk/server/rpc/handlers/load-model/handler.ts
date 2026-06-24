import type {
  LoadModelRequest,
  LoadModelResponse,
  ModelProgressUpdate,
  ReloadConfigRequest,
} from "@/schemas";
import {
  normalizeModelType,
  PROFILING_KEY,
  OPERATION_EVENT_KEY,
  type OperationEvent,
} from "@/schemas";
import { loadModel } from "@/server/bare/ops/load-model";
import { createResolveSession } from "@/server/rpc/handlers/load-model/resolve-session";
import { nowMs, generateProfileId } from "@/profiling/clock";
import {
  getModelEntry,
  updateModelConfig,
} from "@/server/bare/registry/model-registry";
import {
  generateShortHash,
  canonicalConfigString,
  transformConfigForReload,
} from "@/server/utils";
import { buildDownloadProfilingFields } from "@/server/rpc/handlers/load-model/types";
import {
  ConfigReloadNotSupportedError,
  InferenceCancelledError,
  ModelTypeMismatchError,
  ModelIsDelegatedError,
  ModelNotFoundError,
  ModelLoadFailedError,
  PluginLoadConfigValidationFailedError,
  PluginNotFoundError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import { formatZodError } from "@/utils/zod-error";
import { getPlugin } from "@/server/plugins";
import {
  getRequestRegistry,
  withRequestContext,
} from "@/server/bare/runtime";
import { generateServerRequestId } from "@/server/bare/runtime/request-id";

const logger = getServerLogger();

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleLoadModel(
  request: LoadModelRequest,
  progressCallback?: (update: ModelProgressUpdate) => void,
): Promise<LoadModelResponse> {
  if (isReloadConfigRequest(request)) {
    return handleConfigReload(request);
  }

  const { modelSrc, modelName, seed } = request;
  const canonicalModelType = normalizeModelType(request.modelType);

  const profilingMeta = (request as Record<string, unknown>)[PROFILING_KEY] as
    | { enabled?: boolean; id?: string }
    | undefined;
  const profilingEnabled = profilingMeta?.enabled !== false && !!profilingMeta;

  const requestId = request.requestId ?? generateServerRequestId();
  // The handler `modelId` is derived from the config hash below — it
  // isn't known until after `resolveConfig` runs. The registry context
  // is opened with `modelId: undefined` so a cancel-by-modelId fired
  // before the load completes is a clean no-op (rather than matching a
  // half-built entry). Cancel-by-`requestId` works from `begin(...)` on.
  await using ctx = await getRequestRegistry().begin({
    requestId,
    kind: "loadModel",
  });
  const log = withRequestContext(getServerLogger(), ctx);
  log.debug(`loadModel start modelSrc=${String(modelSrc ?? "")}`);

  try {
    const plugin = getPlugin(canonicalModelType);
    if (!plugin) {
      throw new PluginNotFoundError(canonicalModelType);
    }

    let resolvedModelConfig = (request.modelConfig ?? {});

    const parseResult = plugin.loadConfigSchema.safeParse(resolvedModelConfig);
    if (!parseResult.success) {
      throw new PluginLoadConfigValidationFailedError(
        canonicalModelType,
        formatZodError(parseResult.error),
      );
    }
    resolvedModelConfig = parseResult.data as Record<string, unknown>;

    const totalLoadStart = profilingEnabled ? nowMs() : 0;

    const session = createResolveSession({
      progressCallback,
      seed,
      profilingEnabled,
      signal: ctx.signal,
      requestBinding: {
        signal: ctx.signal,
        scope: ctx.scope,
        requestId,
      },
    });

    const primaryResolve = session.resolvePrimaryModelPath(modelSrc);

    let resolvedModelPath: string;
    let pluginResolveResult: Awaited<ReturnType<NonNullable<typeof plugin.resolveConfig>>> | undefined;

    try {
      const pluginResolve = plugin.resolveConfig
        ? Promise.resolve().then(() =>
            plugin.resolveConfig!(
              resolvedModelConfig,
              session.createResolveContext(modelSrc, canonicalModelType, modelName),
            ),
          )
        : undefined;

      [resolvedModelPath, pluginResolveResult] = pluginResolve
        ? await Promise.all([primaryResolve, pluginResolve])
        : [await primaryResolve, undefined];
    } catch (error) {
      session.cancelAll();
      throw error;
    }

    // Phase boundary between download and load. The bare load path
    // (`plugin.createModel(...)` / `model.load(false)`) does not accept
    // an abort signal today, so the only honest cancel hook here is the
    // pre-load gate: if cancel arrived during download / resolveConfig,
    // surface `InferenceCancelledError` before sinking time into the
    // addon work.
    if (ctx.signal.aborted) {
      throw new InferenceCancelledError(requestId);
    }

    const configStr = canonicalConfigString(
      request.modelConfig,
    );
    const modelHashInput = `${request.modelType}:${modelSrc}:${configStr}`;
    const modelId = generateShortHash(modelHashInput);

    let pluginArtifacts: Record<string, string> = {};
    if (pluginResolveResult) {
      resolvedModelConfig = pluginResolveResult.config;
      if (pluginResolveResult.artifacts) {
        pluginArtifacts = pluginResolveResult.artifacts as Record<
          string,
          string
        >;
      }
    }

    if ("modelPath" in pluginArtifacts) {
      throw new ModelLoadFailedError(
        "Plugin returned reserved key \"modelPath\" in artifacts; primary model resolution is core-owned",
      );
    }

    // An empty resolved path is legitimate when the plugin opts out of
    // primary-model-path validation (bundled weights). For every other
    // plugin, an empty path means resolution failed and we must abort.
    if (!resolvedModelPath && !plugin.skipPrimaryModelPathValidation) {
      throw new ModelLoadFailedError("modelPath resolution failed");
    }

    const loadResult = await loadModel(
      {
        modelId,
        modelPath: resolvedModelPath,
        options: {
          ...request,
          modelType: canonicalModelType,
          modelConfig: resolvedModelConfig,
        },
        artifacts: Object.keys(pluginArtifacts).length > 0 ? pluginArtifacts : undefined,
        modelName,
      },
      profilingEnabled ? { collectTiming: true } : undefined,
    );

    // Load phase soft-cancel limitation: `plugin.createModel(...)` and
    // `model.load(false)` ran without a signal. A cancel that arrived
    // during the load phase has just landed in the registry but the
    // model is now loaded and registered. Surface
    // `InferenceCancelledError` so the caller's promise rejects
    // consistently — even though the model state is the "loaded"
    // post-condition. The orphan-model edge case is a known
    // limitation that requires a per-load cancel surface on the addon
    // to fix end-to-end.
    if (ctx.signal.aborted) {
      throw new InferenceCancelledError(requestId);
    }

    const response: LoadModelResponse = {
      type: "loadModel",
      success: true,
      modelId,
    };

    if (profilingEnabled) {
      const totalLoadTimeMs = nowMs() - totalLoadStart;
      const profileId = profilingMeta?.id ?? generateProfileId();

      const resolveResult = session.getAggregateResult();
      const { gauges, tags } = buildDownloadProfilingFields(
        resolveResult?.downloadStats,
        resolveResult?.sourceType,
      );
      gauges["totalLoadTime"] = totalLoadTimeMs;
      if (loadResult.timing?.modelInitializationTimeMs !== undefined) {
        gauges["modelInitializationTime"] =
          loadResult.timing.modelInitializationTimeMs;
      }
      if (canonicalModelType) {
        tags["modelType"] = canonicalModelType;
      }

      const operationEvent: OperationEvent = {
        op: "loadModel",
        kind: "handler",
        ms: totalLoadTimeMs,
        profileId,
        gauges: Object.keys(gauges).length > 0 ? gauges : undefined,
        tags: Object.keys(tags).length > 0 ? tags : undefined,
      };

      (response as LoadModelResponse & { [OPERATION_EVENT_KEY]?: OperationEvent })[OPERATION_EVENT_KEY] = operationEvent;
    }

    return response;
  } catch (error) {
    // `InferenceCancelledError` rides the rejection path verbatim: the
    // client side wants a typed cancel error on the promise it `await`s,
    // not a `{ success: false, error }` envelope that surfaces as a
    // generic `ModelLoadFailedError`. Every other error keeps the
    // legacy `success: false` shape for backward compat with consumers
    // that switch on the envelope.
    if (error instanceof InferenceCancelledError) {
      log.info(`loadModel cancelled requestId=${requestId}`);
      throw error;
    }
    logger.error("Error loading model:", error);
    return {
      type: "loadModel",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleConfigReload(
  request: ReloadConfigRequest,
): Promise<LoadModelResponse> {
  const { modelId, modelType, modelConfig } = request;

  try {
    const entry = getModelEntry(modelId);
    if (!entry) {
      throw new ModelNotFoundError(modelId);
    }

    if (entry.isDelegated) {
      throw new ModelIsDelegatedError(modelId);
    }

    const storedModelType = entry.local.modelType;
    const normalizedRequestType = normalizeModelType(modelType);
    if (storedModelType !== normalizedRequestType) {
      throw new ModelTypeMismatchError(storedModelType, normalizedRequestType);
    }

    const model = entry.local.model;
    const currentConfig = entry.local.config;

    if (typeof model.reload !== "function") {
      throw new ConfigReloadNotSupportedError(modelId);
    }

    const mergedConfig = {
      ...(currentConfig as Record<string, unknown>),
      ...(modelConfig as Record<string, unknown>),
    };

    const reloadConfig = transformConfigForReload(
      storedModelType,
      mergedConfig,
    );

    await model.reload(reloadConfig);
    updateModelConfig(modelId, mergedConfig);

    return {
      type: "loadModel",
      success: true,
      modelId,
    };
  } catch (error) {
    logger.error("Error reloading config:", error);
    return {
      type: "loadModel",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

function isReloadConfigRequest(
  request: LoadModelRequest,
): request is ReloadConfigRequest {
  return "modelId" in request && !("modelSrc" in request);
}

