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
  TtsArtifactsRequiredError,
  TtsReferenceAudioRequiredError,
  ConfigReloadNotSupportedError,
  ModelTypeMismatchError,
  ModelIsDelegatedError,
  ModelNotFoundError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import { OCR_CRAFT_DETECTOR } from "@/models/registry";

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
  const ttsTtsSrcs =
    canonicalModelType === ModelType.onnxTts
      ? (request as {
          ttsTokenizerSrc?: string;
          ttsSpeechEncoderSrc?: string;
          ttsEmbedTokensSrc?: string;
          ttsConditionalDecoderSrc?: string;
          ttsLanguageModelSrc?: string;
          referenceAudioSrc?: string;
        })
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

    let ttsTokenizerPath: string | undefined;
    let ttsSpeechEncoderPath: string | undefined;
    let ttsEmbedTokensPath: string | undefined;
    let ttsConditionalDecoderPath: string | undefined;
    let ttsLanguageModelPath: string | undefined;
    let referenceAudioPath: string | undefined;
    if (canonicalModelType === ModelType.onnxTts && ttsTtsSrcs) {
      const {
        ttsTokenizerSrc,
        ttsSpeechEncoderSrc,
        ttsEmbedTokensSrc,
        ttsConditionalDecoderSrc,
        ttsLanguageModelSrc,
        referenceAudioSrc,
      } = ttsTtsSrcs;
      if (
        !ttsTokenizerSrc ||
        !ttsSpeechEncoderSrc ||
        !ttsEmbedTokensSrc ||
        !ttsConditionalDecoderSrc ||
        !ttsLanguageModelSrc
      ) {
        throw new TtsArtifactsRequiredError();
      }
      if (!referenceAudioSrc) {
        throw new TtsReferenceAudioRequiredError();
      }
      ttsTokenizerPath = await resolveModelPath(
        ttsTokenizerSrc,
        progressCallback,
        seed,
      );
      ttsSpeechEncoderPath = await resolveModelPath(
        ttsSpeechEncoderSrc,
        progressCallback,
        seed,
      );
      ttsEmbedTokensPath = await resolveModelPath(
        ttsEmbedTokensSrc,
        progressCallback,
        seed,
      );
      ttsConditionalDecoderPath = await resolveModelPath(
        ttsConditionalDecoderSrc,
        progressCallback,
        seed,
      );
      ttsLanguageModelPath = await resolveModelPath(
        ttsLanguageModelSrc,
        progressCallback,
        seed,
      );
      referenceAudioPath = await resolveModelPath(
        referenceAudioSrc,
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

    // Generate hash-based modelId
    const configStr = JSON.stringify(
      request.modelConfig,
      Object.keys(request.modelConfig as object).sort(),
    );
    const modelHashInput =
      canonicalModelType === ModelType.onnxTts && ttsTtsSrcs
        ? `${request.modelType}:${modelSrc}:${ttsTtsSrcs.ttsTokenizerSrc}:${ttsTtsSrcs.ttsSpeechEncoderSrc}:${ttsTtsSrcs.ttsEmbedTokensSrc}:${ttsTtsSrcs.ttsConditionalDecoderSrc}:${ttsTtsSrcs.ttsLanguageModelSrc}:${ttsTtsSrcs.referenceAudioSrc ?? ""}:${configStr}`
        : `${request.modelType}:${modelSrc}:${configStr}`;
    const modelId = generateShortHash(modelHashInput);

    const effectiveModelPath =
      canonicalModelType === ModelType.onnxTts && ttsTokenizerPath
        ? ttsTokenizerPath
        : modelPath;

    await loadModel({
      modelId,
      modelPath: effectiveModelPath,
      options: request,
      projectionModelPath,
      vadModelPath,
      ttsTokenizerPath,
      ttsSpeechEncoderPath,
      ttsEmbedTokensPath,
      ttsConditionalDecoderPath,
      ttsLanguageModelPath,
      referenceAudioPath,
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
