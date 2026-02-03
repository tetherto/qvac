import type {
  LoadModelRequest,
  LoadModelResponse,
  ModelProgressUpdate,
  ReloadConfigRequest,
} from "@/schemas";
import { normalizeModelType, ModelType } from "@/schemas";
import { hyperdriveUrlSchema } from "@/schemas/load-model";
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

const OCR_DETECTOR_FILENAME = "detector_craft.onnx";

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
  const canonicalModelType = normalizeModelType(request.modelType);
  const srcVocabSrc =
    canonicalModelType === ModelType.nmtcppTranslation
      ? (request as { srcVocabSrc?: string }).srcVocabSrc
      : undefined;
  const dstVocabSrc =
    canonicalModelType === ModelType.nmtcppTranslation
      ? (request as { dstVocabSrc?: string }).dstVocabSrc
      : undefined;
  const eSpeakDataPath =
    canonicalModelType === ModelType.onnxTts
      ? (request as { eSpeakDataPath?: string }).eSpeakDataPath
      : undefined;
  const detectorModelSrc =
    canonicalModelType === ModelType.onnxOcr
      ? (request as { detectorModelSrc?: string }).detectorModelSrc
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

    // For OCR models: use provided detectorModelSrc or auto-derive from same hyperdrive key
    let detectorModelPath: string | undefined;
    if (canonicalModelType === ModelType.onnxOcr) {
      if (detectorModelSrc) {
        detectorModelPath = await resolveModelPath(
          detectorModelSrc,
          progressCallback,
          seed,
        );
      } else if (modelSrc.startsWith("pear://")) {
        const { key } = hyperdriveUrlSchema.parse(modelSrc);
        const derivedDetectorSrc = `pear://${key}/${OCR_DETECTOR_FILENAME}`;
        detectorModelPath = await resolveModelPath(
          derivedDetectorSrc,
          progressCallback,
          seed,
        );
      }
    }

    // For TTS models, ttsConfigModelPath and eSpeakDataPath are required
    if (canonicalModelType === ModelType.onnxTts && !ttsConfigModelPath) {
      throw new TTSConfigModelRequiredError();
    }
    if (canonicalModelType === ModelType.onnxTts && !eSpeakDataPath) {
      throw new ESpeakDataPathRequiredError();
    }

    // For Bergamot models, resolve vocabulary sources to local paths
    if (
      canonicalModelType === ModelType.nmtcppTranslation &&
      request.modelConfig
    ) {
      const nmtConfig = request.modelConfig as {
        engine?: string;
        srcVocabPath?: string;
        dstVocabPath?: string;
      };
      if (nmtConfig.engine === "Bergamot") {
        let resolvedSrcVocabSrc = srcVocabSrc;
        let resolvedDstVocabSrc = dstVocabSrc;

        if ((!srcVocabSrc || !dstVocabSrc) && modelSrc.startsWith("pear://")) {
          const derivedVocabSrcs = deriveBergamotVocabSources(modelSrc);
          if (derivedVocabSrcs) {
            resolvedSrcVocabSrc = srcVocabSrc ?? derivedVocabSrcs.srcVocabSrc;
            resolvedDstVocabSrc = dstVocabSrc ?? derivedVocabSrcs.dstVocabSrc;
          }
        }

        if (resolvedSrcVocabSrc) {
          nmtConfig.srcVocabPath = await resolveModelPath(
            resolvedSrcVocabSrc,
            progressCallback,
            seed,
          );
        }
        if (resolvedDstVocabSrc) {
          nmtConfig.dstVocabPath = await resolveModelPath(
            resolvedDstVocabSrc,
            progressCallback,
            seed,
          );
        }
      }
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
      detectorModelPath,
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

const BERGAMOT_CJK_LANG_PAIRS = ["enja", "enko", "enzh"];

function deriveBergamotVocabSources(modelSrc: string) {
  const match = modelSrc.match(
    /^pear:\/\/([a-f0-9]+)\/model\.([a-z]+)\.intgemm\.alphas\.bin$/,
  );
  if (!match || !match[1] || !match[2]) return null;

  const key = match[1];
  const langPair = match[2];

  if (BERGAMOT_CJK_LANG_PAIRS.includes(langPair)) {
    return {
      srcVocabSrc: `pear://${key}/srcvocab.${langPair}.spm`,
      dstVocabSrc: `pear://${key}/trgvocab.${langPair}.spm`,
    };
  }

  const sharedVocab = `pear://${key}/vocab.${langPair}.spm`;
  return {
    srcVocabSrc: sharedVocab,
    dstVocabSrc: sharedVocab,
  };
}
