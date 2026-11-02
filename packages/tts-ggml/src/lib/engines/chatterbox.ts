/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
import path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { TTSConfigurationParams } from "../../tts";
import { ENGINE_CHATTERBOX } from "../engineIds";
import type { EngineSetup, ModelPaths } from "../engineSetup";
import {
  fileExistsSafe,
  firstNonEmpty,
  type NormalizedFiles,
} from "../modelFiles";
import {
  assignCommonNativeParams,
  assignSamplingParams,
} from "../nativeParams";

export const CHATTERBOX_T3_TURBO = "chatterbox-t3-turbo.gguf";
export const CHATTERBOX_T3_MTL = "chatterbox-t3-mtl.gguf";
export const CHATTERBOX_S3GEN_DEFAULT = "chatterbox-s3gen.gguf";
export const CHATTERBOX_S3GEN_MTL = "chatterbox-s3gen-mtl.gguf";

export function hasChatterboxModelDir(modelDir: string): boolean {
  return (
    fileExistsSafe(path.join(modelDir, CHATTERBOX_T3_TURBO)) ||
    fileExistsSafe(path.join(modelDir, CHATTERBOX_T3_MTL))
  );
}

function resolveChatterboxModelDirPaths(
  modelDir: string,
): { t3: string; s3: string } {
  const turboT3 = path.join(modelDir, CHATTERBOX_T3_TURBO);
  const multilingualT3 = path.join(modelDir, CHATTERBOX_T3_MTL);
  const defaultS3 = path.join(modelDir, CHATTERBOX_S3GEN_DEFAULT);
  const multilingualS3 = path.join(
    modelDir,
    CHATTERBOX_S3GEN_MTL,
  );
  if (
    fileExistsSafe(multilingualT3) &&
    !fileExistsSafe(turboT3)
  ) {
    return {
      t3: multilingualT3,
      s3: fileExistsSafe(multilingualS3)
        ? multilingualS3
        : defaultS3,
    };
  }
  return { t3: turboT3, s3: defaultS3 };
}

export function resolveChatterboxModelPaths(
  files: NormalizedFiles,
): Pick<ModelPaths, "t3ModelPath" | "s3genModelPath"> {
  if (!files.modelDir) {
    return { t3ModelPath: files.t3Model, s3genModelPath: files.s3genModel };
  }
  const resolved = resolveChatterboxModelDirPaths(files.modelDir);
  return {
    t3ModelPath: firstNonEmpty(files.t3Model, resolved.t3),
    s3genModelPath: firstNonEmpty(files.s3genModel, resolved.s3),
  };
}

export function buildChatterboxParams(
  setup: EngineSetup,
): TTSConfigurationParams {
  const parameters: TTSConfigurationParams = {
    engineType: ENGINE_CHATTERBOX,
    t3ModelPath: setup.paths.t3ModelPath || "",
    s3genModelPath: setup.paths.s3genModelPath || "",
    language: setup.config.language || "en",
  };
  assignCommonNativeParams(setup, parameters);
  if (setup.settings.referenceAudio != null) {
    parameters.referenceAudio = setup.settings.referenceAudio;
  }
  if (setup.settings.voiceDir != null) parameters.voiceDir = setup.settings.voiceDir;
  if (setup.settings.nCtx != null) parameters.nCtx = setup.settings.nCtx | 0;
  if (setup.settings.kvCacheType != null) {
    parameters.kvCacheType = String(setup.settings.kvCacheType);
  }
  if (setup.settings.streamChunkTokens != null) {
    parameters.streamChunkTokens = setup.settings.streamChunkTokens | 0;
  }
  if (setup.settings.streamFirstChunkTokens != null) {
    parameters.streamFirstChunkTokens =
      setup.settings.streamFirstChunkTokens | 0;
  }
  if (setup.settings.cfmSteps != null) {
    parameters.cfmSteps = setup.settings.cfmSteps | 0;
  }
  if (setup.settings.streamLeftContextTokens != null) {
    parameters.streamLeftContextTokens = setup.settings.streamLeftContextTokens | 0;
  }
  if (setup.settings.batchCfmSteps != null) {
    parameters.batchCfmSteps = setup.settings.batchCfmSteps | 0;
  }
  if (setup.settings.cfgRate != null) {
    parameters.cfgRate = Number(setup.settings.cfgRate);
  }
  if (setup.settings.nPredict != null) parameters.nPredict = setup.settings.nPredict | 0;
  if (setup.settings.maxSentenceChars != null) {
    parameters.maxSentenceChars = setup.settings.maxSentenceChars | 0;
  }
  if (setup.settings.crossfadeMs != null) {
    parameters.crossfadeMs = setup.settings.crossfadeMs | 0;
  }
  assignSamplingParams(setup, parameters);
  if (setup.settings.repeatPenalty != null) {
    parameters.repeatPenalty = Number(setup.settings.repeatPenalty);
  }
  if (setup.settings.exaggeration != null) {
    parameters.exaggeration = Number(setup.settings.exaggeration);
  }
  if (setup.settings.cfgWeight != null) {
    parameters.cfgWeight = Number(setup.settings.cfgWeight);
  }
  if (setup.settings.minP != null) parameters.minP = Number(setup.settings.minP);
  if (setup.settings.speed != null) parameters.speed = Number(setup.settings.speed);
  if (setup.paths.mecabDictPath) {
    parameters.mecabDictPath = setup.paths.mecabDictPath;
  }
  if (setup.paths.cangjieTsvPath) {
    parameters.cangjieTsvPath = setup.paths.cangjieTsvPath;
  }
  return parameters;
}
