import type {
  LoadModelRequest,
  LoadModelResponse,
  ModelProgressUpdate,
  ReloadConfigRequest,
} from "@/schemas";
import { normalizeModelType, ModelType } from "@/schemas";
import { hyperdriveUrlSchema } from "@/schemas/load-model";
import { loadModel } from "@/server/bare/ops/load-model";
import { resolveModelPath } from "@/server/rpc/handlers/load-model/resolve";
import {
  getModelEntry,
  updateModelConfig,
} from "@/server/bare/registry/model-registry";
import { generateShortHash, transformConfigForReload } from "@/server/utils";
import {
  ConfigReloadNotSupportedError,
  ModelTypeMismatchError,
  ModelIsDelegatedError,
  ModelNotFoundError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import { OCR_CRAFT_DETECTOR } from "@/models/registry";
import { getPlugin } from "@/server/plugins";

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
  const { modelSrc, modelName, seed, projectionModelSrc, vadModelSrc } =
    request;
  const canonicalModelType = normalizeModelType(request.modelType);
  const srcVocabSrc =
    canonicalModelType === ModelType.nmtcppTranslation
      ? (request as { srcVocabSrc?: string }).srcVocabSrc
      : undefined;
  const dstVocabSrc =
    canonicalModelType === ModelType.nmtcppTranslation
      ? (request as { dstVocabSrc?: string }).dstVocabSrc
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

    // For OCR models: use provided detectorModelSrc or auto-derive
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
      } else if (modelSrc.startsWith("registry://")) {
        detectorModelPath = await resolveModelPath(
          OCR_CRAFT_DETECTOR,
          progressCallback,
          seed,
        );
      }
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

        if (!srcVocabSrc || !dstVocabSrc) {
          const derivedVocabSrcs = modelSrc.startsWith("pear://")
            ? deriveBergamotVocabSources(modelSrc)
            : modelSrc.startsWith("registry://")
              ? deriveBergamotRegistryVocabSources(modelSrc)
              : null;
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

    // Use plugin's resolveConfig hook if available to resolve model sources
    let resolvedModelConfig = request.modelConfig as
      | Record<string, unknown>
      | undefined;
    const plugin = getPlugin(canonicalModelType);
    if (plugin?.resolveConfig && resolvedModelConfig) {
      const resolve = (src: string) =>
        resolveModelPath(src, progressCallback, seed);
      resolvedModelConfig = await plugin.resolveConfig(
        resolvedModelConfig,
        resolve,
      );
    }

    // Generate hash-based modelId from modelConfig (includes all sources for TTS)
    const configStr = JSON.stringify(
      request.modelConfig,
      Object.keys(request.modelConfig as object).sort(),
    );
    const modelHashInput = `${request.modelType}:${modelSrc}:${configStr}`;
    const modelId = generateShortHash(modelHashInput);

    const loadModelOptions = {
      ...request,
      modelConfig: resolvedModelConfig,
    };

    await loadModel({
      modelId,
      modelPath,
      options: loadModelOptions,
      projectionModelPath,
      vadModelPath,
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

function deriveBergamotRegistryVocabSources(modelSrc: string) {
  // registry://s3/path/to/model.enfr.intgemm.alphas.bin
  const match = modelSrc.match(
    /^(registry:\/\/.+\/)model\.([a-z]+)\.intgemm\.alphas\.bin$/,
  );
  if (!match || !match[1] || !match[2]) return null;

  const basePath = match[1];
  const langPair = match[2];

  if (BERGAMOT_CJK_LANG_PAIRS.includes(langPair)) {
    return {
      srcVocabSrc: `${basePath}srcvocab.${langPair}.spm`,
      dstVocabSrc: `${basePath}trgvocab.${langPair}.spm`,
    };
  }

  const sharedVocab = `${basePath}vocab.${langPair}.spm`;
  return {
    srcVocabSrc: sharedVocab,
    dstVocabSrc: sharedVocab,
  };
}
