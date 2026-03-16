import type {
  LoadModelRequest,
  LoadModelResponse,
  ModelProgressUpdate,
  ReloadConfigRequest,
  ResolveContext,
} from "@/schemas";
import { normalizeModelType } from "@/schemas";
import { loadModel } from "@/server/bare/ops/load-model";
import { resolveModelPath } from "@/server/rpc/handlers/load-model/resolve";
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

type ResolveFn = (src: unknown) => Promise<string>;

// ---------------------------------------------------------------------------
// Generic parallel resolver — resolves a named set of sources concurrently
// ---------------------------------------------------------------------------

async function resolveInParallel(
  resolve: ResolveFn,
  sources: Record<string, unknown>,
): Promise<Record<string, string>> {
  const entries = Object.entries(sources);
  const paths = await Promise.all(entries.map(([, src]) => resolve(src)));
  return Object.fromEntries(entries.map(([key], i) => [key, paths[i]!]));
}

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

    const resolve: ResolveFn = (src) =>
      resolveModelPath(src, progressCallback, seed);

    const resolved = await resolveInParallel(resolve, {
      modelPath: modelSrc,
    });

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

    const collisions = Object.keys(pluginArtifacts).filter(
      (k) => k in resolved,
    );
    if (collisions.length > 0) {
      logger.warn(
        `Plugin returned artifact keys that were overridden by core: ${collisions.join(", ")}`,
      );
    }

    const allArtifacts = { ...pluginArtifacts, ...resolved };
    const { modelPath: resolvedModelPath, ...artifacts } = allArtifacts;

    if (!resolvedModelPath) {
      throw new ModelLoadFailedError("modelPath resolution failed");
    }

    await loadModel({
      modelId,
      modelPath: resolvedModelPath,
      options: {
        ...request,
        modelType: canonicalModelType,
        modelConfig: resolvedModelConfig,
      },
      artifacts: Object.keys(artifacts).length > 0 ? artifacts : undefined,
      modelName,
    });

    return {
      type: "loadModel",
      success: true,
      modelId,
    };
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
