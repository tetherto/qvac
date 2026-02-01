import type {
  LoadModelRequest,
  LoadModelResponse,
  ModelProgressUpdate,
  ReloadConfigRequest,
} from "@/schemas";
import { loadModel } from "@/server/bare/addons";
import { resolveModelPath } from "@/server/rpc/handlers/load-model/resolve";
import {
  getModelEntry,
  updateModelConfig,
} from "@/server/bare/registry/model-registry";
import { generateShortHash, transformConfigForReload } from "@/server/utils";
import {
  TTSConfigModelRequiredError,
  ESpeakDataPathRequiredError,
  ConfigReloadNotSupportedError,
  ModelTypeMismatchError,
  ModelIsDelegatedError,
  ModelNotFoundError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function handleLoadModel(
  request: LoadModelRequest,
  progressCallback?: (update: ModelProgressUpdate) => void,
): Promise<LoadModelResponse> {
  // Handle reload config
  if (isReloadConfigRequest(request)) {
    return handleConfigReload(request);
  }

  // Handle load new model from source
  const {
    modelSrc,
    modelName,
    seed,
    projectionModelSrc,
    vadModelSrc,
    configSrc,
  } = request;
  const eSpeakDataPath =
    request.modelType === "tts"
      ? (request as { eSpeakDataPath?: string }).eSpeakDataPath
      : undefined;

  try {
    const modelPath = await resolveModelPath(modelSrc, progressCallback, seed);

    let projectionModelPath: string | undefined;
    if (projectionModelSrc) {
      projectionModelPath = await resolveModelPath(
        projectionModelSrc,
        progressCallback,
        seed,
      );
    }

    let vadModelPath: string | undefined;
    if (vadModelSrc) {
      vadModelPath = await resolveModelPath(
        vadModelSrc,
        progressCallback,
        seed,
      );
    }

    let ttsConfigModelPath: string | undefined;
    if (configSrc) {
      ttsConfigModelPath = await resolveModelPath(
        configSrc,
        progressCallback,
        seed,
      );
    }

    // For TTS models, ttsConfigModelPath and eSpeakDataPath are required
    if (request.modelType === "tts" && !ttsConfigModelPath) {
      throw new TTSConfigModelRequiredError();
    }
    if (request.modelType === "tts" && !eSpeakDataPath) {
      throw new ESpeakDataPathRequiredError();
    }
    // Generate hash-based modelId
    const configStr = JSON.stringify(
      request.modelConfig,
      Object.keys(request.modelConfig as object).sort(),
    );
    const modelHashInput = `${request.modelType}:${modelSrc}:${configStr}`;
    const modelId = generateShortHash(modelHashInput);

    await loadModel({
      modelId,
      modelPath,
      options: request,
      projectionModelPath,
      vadModelPath,
      ttsConfigModelPath,
      eSpeakDataPath,
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
    if (storedModelType !== modelType) {
      throw new ModelTypeMismatchError(storedModelType, modelType);
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
