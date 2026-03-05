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

type ResolveFn = (src: unknown) => Promise<string>;

// ---------------------------------------------------------------------------
// Source derivation — pure functions that figure out which sources to resolve
// ---------------------------------------------------------------------------

function getOcrCompanionSources(
  modelSrc: string,
  detectorModelSrc?: string,
): Record<string, unknown> {
  if (detectorModelSrc) return { detectorModelPath: detectorModelSrc };
  if (modelSrc.startsWith("pear://")) {
    const { key } = hyperdriveUrlSchema.parse(modelSrc);
    return { detectorModelPath: `pear://${key}/${OCR_DETECTOR_FILENAME}` };
  }
  if (modelSrc.startsWith("registry://")) {
    return { detectorModelPath: OCR_CRAFT_DETECTOR };
  }
  return {};
}

function getNmtCompanionSources(
  modelSrc: string,
  modelConfig: unknown,
  srcVocabSrc?: string,
  dstVocabSrc?: string,
): Record<string, string> {
  const config = modelConfig as { engine?: string } | undefined;
  if (config?.engine !== "Bergamot") return {};

  let src = srcVocabSrc;
  let dst = dstVocabSrc;

  if (!srcVocabSrc || !dstVocabSrc) {
    const derived = modelSrc.startsWith("pear://")
      ? deriveBergamotVocabSources(modelSrc)
      : modelSrc.startsWith("registry://")
        ? deriveBergamotRegistryVocabSources(modelSrc)
        : null;
    if (derived) {
      src = srcVocabSrc ?? derived.srcVocabSrc;
      dst = dstVocabSrc ?? derived.dstVocabSrc;
    }
  }

  const result: Record<string, string> = {};
  if (src) result["srcVocabPath"] = src;
  if (dst) result["dstVocabPath"] = dst;
  return result;
}

function getDefaultCompanionSources(
  projectionModelSrc?: string,
  vadModelSrc?: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (projectionModelSrc) result["projectionModelPath"] = projectionModelSrc;
  if (vadModelSrc) result["vadModelPath"] = vadModelSrc;
  return result;
}

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
    const resolve: ResolveFn = (src) => resolveModelPath(src, progressCallback, seed);

    // Companion sources are mutually exclusive per model type (schema union).
    // Each derive function returns only the sources relevant to its type.
    const companions =
      canonicalModelType === ModelType.onnxOcr
        ? getOcrCompanionSources(modelSrc, detectorModelSrc)
        : canonicalModelType === ModelType.nmtcppTranslation
          ? getNmtCompanionSources(modelSrc, request.modelConfig, srcVocabSrc, dstVocabSrc)
          : getDefaultCompanionSources(projectionModelSrc, vadModelSrc);

    const resolved = await resolveInParallel(resolve, {
      modelPath: modelSrc,
      ...companions,
    });

    // Apply NMT vocab paths back to config
    if (resolved["srcVocabPath"] || resolved["dstVocabPath"]) {
      const nmtConfig = request.modelConfig as {
        srcVocabPath?: string;
        dstVocabPath?: string;
      };
      if (resolved["srcVocabPath"]) nmtConfig.srcVocabPath = resolved["srcVocabPath"];
      if (resolved["dstVocabPath"]) nmtConfig.dstVocabPath = resolved["dstVocabPath"];
    }

    // Use plugin's resolveConfig hook if available (e.g. TTS, Parakeet)
    let resolvedModelConfig = request.modelConfig as
      | Record<string, unknown>
      | undefined;
    const plugin = getPlugin(canonicalModelType);
    if (plugin?.resolveConfig && resolvedModelConfig) {
      resolvedModelConfig = await plugin.resolveConfig(
        resolvedModelConfig,
        (src: string) => resolveModelPath(src, progressCallback, seed),
      );
    }

    const configStr = JSON.stringify(
      request.modelConfig,
      Object.keys(request.modelConfig as object).sort(),
    );
    const modelHashInput = `${request.modelType}:${modelSrc}:${configStr}`;
    const modelId = generateShortHash(modelHashInput);

    await loadModel({
      modelId,
      modelPath: resolved["modelPath"]!,
      options: { ...request, modelConfig: resolvedModelConfig },
      projectionModelPath: resolved["projectionModelPath"],
      vadModelPath: resolved["vadModelPath"],
      detectorModelPath: resolved["detectorModelPath"],
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
