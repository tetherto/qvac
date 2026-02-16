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
import {
  generateShortHash,
  transformConfigForReload,
  getModelsCacheDir,
} from "@/server/utils";
import {
  TTSConfigModelRequiredError,
  ESpeakDataPathRequiredError,
  ConfigReloadNotSupportedError,
  ModelTypeMismatchError,
  ModelIsDelegatedError,
  ModelNotFoundError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import { OCR_CRAFT_DETECTOR } from "@/models/registry";
import { downloadParakeetModelFromHttp } from "@/server/rpc/handlers/load-model/http";
import fs, { promises as fsPromises } from "bare-fs";
import path from "bare-path";

const logger = getServerLogger();

const OCR_DETECTOR_FILENAME = "detector_craft.onnx";

/**
 * Sibling files that must be co-located with the Parakeet encoder.
 * "nemo128.onnx" is the preprocessor, renamed to "preprocessor.onnx" in the
 * assembled model directory because that is what the addon expects.
 */
const PARAKEET_SIBLING_FILES: readonly { src: string; dst: string }[] = [
  { src: "encoder-model.onnx.data", dst: "encoder-model.onnx.data" },
  { src: "decoder_joint-model.onnx", dst: "decoder_joint-model.onnx" },
  { src: "vocab.txt", dst: "vocab.txt" },
  { src: "nemo128.onnx", dst: "preprocessor.onnx" },
];

/**
 * Downloads all Parakeet model files from the registry, assembles them in a
 * shared directory, and returns the path to encoder-model.onnx.
 *
 * The primary modelSrc points to encoder-model.onnx; sibling files are
 * auto-derived from the same base path (same HuggingFace repo / commit).
 */
async function downloadParakeetFromRegistry(
  modelSrc: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  seed?: boolean,
): Promise<string> {
  const lastSlash = modelSrc.lastIndexOf("/");
  const basePath = modelSrc.substring(0, lastSlash + 1);

  const assemblyKey = generateShortHash(basePath);
  const modelDir = path.join(getModelsCacheDir(), `parakeet_${assemblyKey}`);

  try {
    await fsPromises.mkdir(modelDir, { recursive: true });
  } catch {
    // directory may already exist
  }

  // Download encoder-model.onnx (the primary file)
  const encoderCachePath = await resolveModelPath(
    modelSrc,
    progressCallback,
    seed,
  );
  ensureLinkSync(encoderCachePath, path.join(modelDir, "encoder-model.onnx"));

  // Download and link each sibling
  for (const { src, dst } of PARAKEET_SIBLING_FILES) {
    const siblingUrl = `${basePath}${src}`;
    logger.info(`Auto-deriving parakeet sibling: ${siblingUrl}`);

    const siblingCachePath = await resolveModelPath(
      siblingUrl,
      progressCallback,
      seed,
    );
    ensureLinkSync(siblingCachePath, path.join(modelDir, dst));
  }

  logger.info(`✅ Parakeet model assembled in: ${modelDir}`);
  return path.join(modelDir, "encoder-model.onnx");
}

/**
 * Create a symlink from `target` to `linkPath` if it does not already exist.
 * Falls back to copying if symlinks are not supported.
 */
function ensureLinkSync(target: string, linkPath: string): void {
  try {
    fs.accessSync(linkPath);
    return; // already exists
  } catch {
    // does not exist yet
  }

  try {
    fs.symlinkSync(target, linkPath);
  } catch {
    // symlink may fail on some filesystems; fall back to copy
    fs.copyFileSync(target, linkPath);
  }
}

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
    // Parakeet models are multi-file: auto-derive siblings for HTTP and registry
    let modelPath: string;
    if (
      canonicalModelType === ModelType.parakeetTranscription &&
      typeof modelSrc === "string" &&
      (modelSrc.startsWith("http://") || modelSrc.startsWith("https://"))
    ) {
      modelPath = await downloadParakeetModelFromHttp(
        modelSrc,
        progressCallback,
      );
    } else if (
      canonicalModelType === ModelType.parakeetTranscription &&
      typeof modelSrc === "string" &&
      modelSrc.startsWith("registry://")
    ) {
      modelPath = await downloadParakeetFromRegistry(
        modelSrc,
        progressCallback,
        seed,
      );
    } else {
      modelPath = await resolveModelPath(modelSrc, progressCallback, seed);
    }

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
    if (canonicalModelType === ModelType.onnxTts) {
      if (configSrc) {
        ttsConfigModelPath = await resolveModelPath(
          configSrc,
          progressCallback,
          seed,
        );
      } else if (modelSrc.startsWith("registry://")) {
        // Registry: config is the model path + ".json"
        // e.g., registry://hf/path/model.onnx -> registry://hf/path/model.onnx.json
        const derivedConfigSrc = `${modelSrc}.json`;
        logger.info(`Auto-deriving TTS config from: ${derivedConfigSrc}`);
        ttsConfigModelPath = await resolveModelPath(
          derivedConfigSrc,
          progressCallback,
          seed,
        );
      }
    } else if (configSrc) {
      // For non-TTS models, still resolve configSrc if provided
      ttsConfigModelPath = await resolveModelPath(
        configSrc,
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
