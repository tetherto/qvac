/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
import fs = require("bare-fs");
import path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { TTSConfigurationParams } from "../../tts";
import { ENGINE_SUPERTONIC } from "../engineIds";
import type { EngineSetup, ModelPaths } from "../engineSetup";
import {
  fileExistsSafe,
  firstNonEmpty,
  type NormalizedFiles,
} from "../modelFiles";
import { assignCommonNativeParams } from "../nativeParams";

export const SUPERTONIC_DEFAULT = "supertonic.gguf";
export const SUPERTONIC_MTL = "supertonic2.gguf";
export const SUPERTONIC_V3_RE = /^supertonic3(-[a-z0-9_]+)?\.gguf$/i;
export const SUPERTONIC_V3_QUANT_ORDER = [
  "f16",
  "f32",
  "q8_0",
  "q4_0",
];

export function findSupertonicV3InDir(
  modelDir?: string,
): string | undefined {
  if (!modelDir) return undefined;
  let entries: string[];
  try {
    entries = fs.readdirSync(modelDir);
  } catch {
    return undefined;
  }
  const matches = entries.filter((name) =>
    SUPERTONIC_V3_RE.test(name),
  );
  if (matches.length === 0) return undefined;
  function rank(name: string): number {
    if (/^supertonic3\.gguf$/i.test(name)) return 0;
    const match = name.match(/^supertonic3-(.+)\.gguf$/i);
    const index = match
      ? SUPERTONIC_V3_QUANT_ORDER.indexOf(match[1].toLowerCase())
      : -1;
    return index === -1
      ? SUPERTONIC_V3_QUANT_ORDER.length + 1
      : index + 1;
  }
  matches.sort((left, right) => rank(left) - rank(right));
  return path.join(modelDir, matches[0]);
}

export function hasSupertonicModelDir(modelDir: string): boolean {
  return (
    fileExistsSafe(path.join(modelDir, SUPERTONIC_DEFAULT)) ||
    fileExistsSafe(path.join(modelDir, SUPERTONIC_MTL)) ||
    !!findSupertonicV3InDir(modelDir)
  );
}

function resolveSupertonicModelDirPath(modelDir: string): string {
  const english = path.join(modelDir, SUPERTONIC_DEFAULT);
  const multilingual = path.join(modelDir, SUPERTONIC_MTL);
  const versionThree = findSupertonicV3InDir(modelDir);
  if (fileExistsSafe(english)) return english;
  if (fileExistsSafe(multilingual)) return multilingual;
  if (versionThree) return versionThree;
  return english;
}

export function resolveSupertonicModelPaths(
  files: NormalizedFiles,
): Pick<ModelPaths, "supertonicModelPath"> {
  return {
    supertonicModelPath: firstNonEmpty(
      files.supertonicModel,
      files.modelDir ? resolveSupertonicModelDirPath(files.modelDir) : undefined,
    ),
  };
}

export function buildSupertonicParams(
  setup: EngineSetup,
): TTSConfigurationParams {
  const parameters: TTSConfigurationParams = {
    engineType: ENGINE_SUPERTONIC,
    supertonicModelPath: setup.paths.supertonicModelPath || "",
    language: setup.config.language || "en",
  };
  assignCommonNativeParams(setup, parameters);
  if (setup.settings.voice) parameters.voice = setup.settings.voice;
  if (setup.settings.steps != null) parameters.steps = setup.settings.steps | 0;
  if (setup.settings.speed != null) parameters.speed = Number(setup.settings.speed);
  // The native layer maps the step onto a multiplier relative to the GGUF's
  // own default_speed, and rejects pace + speed together.
  if (setup.settings.pace != null) parameters.pace = String(setup.settings.pace);
  if (setup.settings.noiseNpyPath) {
    parameters.noiseNpyPath = setup.settings.noiseNpyPath;
  }
  if (setup.backend.vulkanCacheDir) {
    parameters.vulkanCacheDir = setup.backend.vulkanCacheDir;
  }
  if (setup.settings.voiceJsonPath) parameters.voiceJsonPath = setup.settings.voiceJsonPath;
  if (setup.settings.prewarmText) parameters.prewarmText = setup.settings.prewarmText;
  if (setup.settings.vulkanDevice != null) {
    parameters.vulkanDevice = setup.settings.vulkanDevice | 0;
  }
  if (setup.settings.streamChunkTokens != null) {
    parameters.streamChunkTokens = setup.settings.streamChunkTokens | 0;
  }
  if (setup.settings.streamFirstChunkTokens != null) {
    parameters.streamFirstChunkTokens = setup.settings.streamFirstChunkTokens | 0;
  }
  if (setup.settings.streamChunkTolerancePct != null) {
    parameters.streamChunkTolerancePct = setup.settings.streamChunkTolerancePct | 0;
  }
  if (setup.settings.streamMinChunkTokens != null) {
    parameters.streamMinChunkTokens = setup.settings.streamMinChunkTokens | 0;
  }
  return parameters;
}
