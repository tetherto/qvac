import type {
  LoadModelRequest,
  LoadModelResponse,
  ModelProgressUpdate,
  ReloadConfigRequest,
  ResolveContext,
} from "@/schemas";
import {
  normalizeModelType,
  PROFILING_KEY,
  OPERATION_EVENT_KEY,
  type OperationEvent,
} from "@/schemas";
import { loadModel } from "@/server/bare/ops/load-model";
import {
  resolveModelPath,
  resolveModelPathWithStats,
} from "@/server/rpc/handlers/load-model/resolve";
import type { ResolveResult } from "./types";
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
import {
  ConfigReloadNotSupportedError,
  ModelTypeMismatchError,
  ModelIsDelegatedError,
  ModelNotFoundError,
  ModelLoadFailedError,
  PluginLoadConfigValidationFailedError,
  PluginNotFoundError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import { getPlugin } from "@/server/plugins";

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

  try {
    const plugin = getPlugin(canonicalModelType);
    if (!plugin) {
      throw new PluginNotFoundError(canonicalModelType);
    }

    let resolvedModelConfig = (request.modelConfig ?? {}) as Record<
      string,
      unknown
    >;

    const parseResult = plugin.loadConfigSchema.safeParse(resolvedModelConfig);
    if (!parseResult.success) {
      const details = parseResult.error.issues
        .map(
          (i: { path: unknown[]; message: string }) =>
            `${String(i.path.join("."))}: ${i.message}`,
        )
        .join(", ");
      throw new PluginLoadConfigValidationFailedError(
        canonicalModelType,
        details,
      );
    }
    resolvedModelConfig = parseResult.data as Record<string, unknown>;

    const totalLoadStart = profilingEnabled ? nowMs() : 0;

    let resolveResult: ResolveResult | undefined;
    let resolvedModelPath: string;

    if (profilingEnabled) {
      resolveResult = await resolveModelPathWithStats(
        modelSrc,
        progressCallback,
        seed,
      );
      resolvedModelPath = resolveResult.path;
    } else {
      resolvedModelPath = await resolveModelPath(
        modelSrc,
        progressCallback,
        seed,
      );
    }

    let pluginArtifacts: Record<string, string> = {};
    if (plugin.resolveConfig) {
      const ctx: ResolveContext = {
        resolveModelPath: (src) =>
          resolveModelPath(src, progressCallback, seed),
        modelSrc,
        modelType: canonicalModelType,
        ...(modelName !== undefined && { modelName }),
      };
      const result = await plugin.resolveConfig(resolvedModelConfig, ctx);
      resolvedModelConfig = result.config;
      if (result.artifacts) {
        pluginArtifacts = result.artifacts as Record<string, string>;
      }
    }

    const configStr = canonicalConfigString(
      request.modelConfig as Record<string, unknown> | undefined,
    );
    const modelHashInput = `${request.modelType}:${modelSrc}:${configStr}`;
    const modelId = generateShortHash(modelHashInput);

    if ("modelPath" in pluginArtifacts) {
      logger.warn(
        "Plugin returned 'modelPath' artifact which was overridden by core",
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { modelPath: _, ...artifacts } = pluginArtifacts;

    if (!resolvedModelPath) {
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
        artifacts: Object.keys(artifacts).length > 0 ? artifacts : undefined,
        modelName,
      },
      profilingEnabled ? { collectTiming: true } : undefined,
    );

    const response: LoadModelResponse = {
      type: "loadModel",
      success: true,
      modelId,
    };

    if (profilingEnabled) {
      const totalLoadTimeMs = nowMs() - totalLoadStart;
      const profileId = profilingMeta?.id ?? generateProfileId();

      const gauges: Record<string, number> = {
        totalLoadTime: totalLoadTimeMs,
      };
      if (loadResult.timing?.modelInitializationTimeMs !== undefined) {
        gauges["modelInitializationTime"] =
          loadResult.timing.modelInitializationTimeMs;
      }
      if (resolveResult?.downloadStats) {
        const ds = resolveResult.downloadStats;
        if (ds.downloadTimeMs !== undefined) {
          gauges["downloadTime"] = ds.downloadTimeMs;
        }
        if (ds.totalBytesDownloaded !== undefined) {
          gauges["totalBytesDownloaded"] = ds.totalBytesDownloaded;
        }
        if (ds.downloadSpeedBps !== undefined) {
          gauges["downloadSpeedBps"] = ds.downloadSpeedBps;
        }
        if (ds.checksumValidationTimeMs !== undefined) {
          gauges["checksumValidationTime"] = ds.checksumValidationTimeMs;
        }
      }

      const tags: Record<string, string> = {};
      if (canonicalModelType) {
        tags["modelType"] = canonicalModelType;
      }
      if (resolveResult?.sourceType) {
        tags["sourceType"] = resolveResult.sourceType;
      }
      if (resolveResult?.downloadStats?.cacheHit !== undefined) {
        tags["cacheHit"] = resolveResult.downloadStats.cacheHit ? "true" : "false";
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

    const storedModelType = entry.local!.modelType;
    const normalizedRequestType = normalizeModelType(modelType);
    if (storedModelType !== normalizedRequestType) {
      throw new ModelTypeMismatchError(storedModelType, normalizedRequestType);
    }

    const model = entry.local!.model;
    const currentConfig = entry.local!.config;

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
