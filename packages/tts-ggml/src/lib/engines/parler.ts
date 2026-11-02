/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
import fs = require("bare-fs");
import path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { TTSConfigurationParams } from "../../tts";
import {
  assertPerCallConditioning,
  pickConditioningFields,
  validateConditioning,
  type Emotion,
  type Pace,
  type TTSConditioningFields,
} from "../conditioning";
import { ENGINE_PARLER } from "../engineIds";
import type { EngineSetup, ModelPaths, SynthesisSettings } from "../engineSetup";
import { firstNonEmpty, type NormalizedFiles } from "../modelFiles";
import { assignBackendParams, assignSamplingParams } from "../nativeParams";
import { setOptionNames } from "../options";

// Parler GGUFs ship per quant tier with the quant in the filename
// (`parler-mini-v1-q8_0.gguf`); a bare `parler.gguf` deliberately does not
// match, keeping ambiguous files out of the modelDir auto-detect path.
export const PARLER_RE =
  /^parler-(mini|large|indic)(-v\d+)?(-[a-z0-9_]+)?\.gguf$/i;
export const PARLER_VARIANT_ORDER = ["mini", "large", "indic"];
export const PARLER_QUANT_ORDER = ["q8_0", "q6_k", "f16", "f32"];
export const PARLER_DESCRIPTION_KEYS = ["description", "voiceDescription"] as const;
// What native Parler reads as template fields. `emotion` / `pace` stay listed
// here because build_description() still renders them, even though they are
// cross-engine options at the JS surface.
export const PARLER_TEMPLATE_KEYS = [
  "voice",
  "emotion",
  "pitch",
  "pace",
  "expressivity",
  "noise",
  "reverb",
  "quality",
] as const;
// The subset that stays Parler-only now that emotion/pace are cross-engine.
export const PARLER_ONLY_TEMPLATE_KEYS = [
  "voice",
  "pitch",
  "expressivity",
  "noise",
  "reverb",
  "quality",
] as const;
export const PARLER_FIELD_KEYS = [
  ...PARLER_DESCRIPTION_KEYS,
  ...PARLER_TEMPLATE_KEYS,
] as const;
export const PARLER_ONLY_KEYS = [
  ...PARLER_DESCRIPTION_KEYS,
  ...PARLER_ONLY_TEMPLATE_KEYS,
] as const;
export type ParlerFieldKey = (typeof PARLER_FIELD_KEYS)[number];
export type ParlerDescFields = Partial<Record<ParlerFieldKey, string>>;
// Everything legal on one job object: Parler's description/template surface
// plus the cross-engine conditioning that Parler also renders.
export type ParlerJobSource = ParlerDescriptionFields & TTSConditioningFields;

/**
 * Parler voice-description inputs. Either a free-text `description` (alias
 * `voiceDescription`) or the template fields, rendered natively through
 * tts-cpp's build_description(); mixing the two at the same level is rejected.
 * Accepted at construction, on `reload()`, and per call (Parler only).
 * `emotion` and `pace` moved to TTSConditioningFields -- Parler still renders
 * both, but they are no longer Parler-only at the JS surface.
 */
export interface ParlerDescriptionFields {
  description?: string;
  voiceDescription?: string;
  /** Parler voice-template field; also Supertonic's baked voice id. */
  voice?: string;
  pitch?: string;
  expressivity?: string;
  noise?: string;
  reverb?: string;
  quality?: string;
}

/**
 * Find a Parler GGUF in `modelDir`, ranked by variant (mini before large
 * before indic) and, within a variant, by quant tier (q8_0 > q6_k > f16 > f32;
 * a bare `parler-<variant>.gguf` wins as forward-compat).
 */
export function findParlerInDir(modelDir?: string): string | undefined {
  if (!modelDir) return undefined;
  let entries: string[];
  try {
    entries = fs.readdirSync(modelDir);
  } catch {
    return undefined;
  }
  const matches = entries.filter((name) => PARLER_RE.test(name));
  if (matches.length === 0) return undefined;
  function rank(name: string): number {
    const match = name.match(PARLER_RE);
    if (!match) return Number.MAX_SAFE_INTEGER;
    const variant = PARLER_VARIANT_ORDER.indexOf(
      match[1].toLowerCase(),
    );
    let quantRank = 0;
    if (match[3]) {
      const index = PARLER_QUANT_ORDER.indexOf(
        match[3].slice(1).toLowerCase(),
      );
      quantRank =
        index === -1 ? PARLER_QUANT_ORDER.length + 2 : index + 1;
    }
    return variant * 100 + quantRank;
  }
  matches.sort((left, right) => rank(left) - rank(right));
  return path.join(modelDir, matches[0]);
}

/**
 * Collect the Parler description/template properties present on `source`
 * (a run input, streaming options, or constructor options). Returns undefined
 * when none are set.
 */
export function pickParlerDescFields(
  source: ParlerJobSource | null | undefined,
): ParlerDescFields | undefined {
  if (source == null || typeof source !== "object") return undefined;
  const out: ParlerDescFields = {};
  let any = false;
  for (const key of PARLER_FIELD_KEYS) {
    const value = source[key];
    if (value != null && value !== "") {
      out[key] = String(value);
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * Same-level conflict check: a free-text description cannot be merged with
 * template fields, so setting both together is an error.
 */
export function assertParlerDescFieldsConsistent(
  fields: ParlerDescFields | undefined,
  where: string,
): void {
  if (!fields) return;
  const hasDescription = PARLER_DESCRIPTION_KEYS.some(
    (key) => fields[key] != null,
  );
  const templateKeys = PARLER_TEMPLATE_KEYS.filter(
    (key) => fields[key] != null,
  );
  if (hasDescription && templateKeys.length > 0) {
    throw new Error(
      `tts-ggml: ${where}: 'description' is mutually exclusive with the ` +
        `voice-template options (got ${templateKeys.join(", ")})`,
    );
  }
}

export function resolveParlerModelPaths(
  files: NormalizedFiles,
): Pick<ModelPaths, "parlerModelPath"> {
  return {
    parlerModelPath: firstNonEmpty(
      files.parlerModel,
      files.modelDir ? findParlerInDir(files.modelDir) : undefined,
    ),
  };
}

/**
 * Constructor-time rules: on Parler the description and template fields are
 * mutually exclusive; on every other engine the Parler-only options are
 * rejected by name.
 */
export function assertParlerOptions(setup: EngineSetup): void {
  if (setup.engineType === ENGINE_PARLER) {
    assertParlerDescFieldsConsistent(
      pickParlerDescFields({
        description: setup.settings.description,
        voice: setup.settings.voice,
        emotion: setup.settings.emotion as Emotion | undefined,
        pitch: setup.settings.pitch,
        pace: setup.settings.pace as Pace | undefined,
        expressivity: setup.settings.expressivity,
        noise: setup.settings.noise,
        reverb: setup.settings.reverb,
        quality: setup.settings.quality,
      }),
      "constructor",
    );
    return;
  }
  const parlerOnly: string[] = [];
  if (setup.settings.description != null) {
    parlerOnly.push("description/voiceDescription");
  }
  // emotion / pace are absent because they are cross-engine, validated by
  // assertConditioningConsistency; temperature / topK / topP / maxFrames are
  // absent because audio8 samples too, so SAMPLING_ENGINES decides them.
  parlerOnly.push(
    ...setOptionNames({
      pitch: setup.settings.pitch,
      expressivity: setup.settings.expressivity,
      noise: setup.settings.noise,
      reverb: setup.settings.reverb,
      quality: setup.settings.quality,
      minNewTokens: setup.settings.minNewTokens,
      normalizeNumbers: setup.settings.normalizeNumbers,
    }),
  );
  if (parlerOnly.length > 0) {
    throw new Error(
      `tts-ggml: ${parlerOnly.join(", ")} are parler-only options ` +
        `(engine is ${setup.engineType})`,
    );
  }
}

/**
 * Parler's per-call surface: description/template fields, where a per-call
 * template cannot be merged with a constructor-level free-text description.
 */
export function resolveParlerJobFields(
  setup: EngineSetup,
  source: ParlerJobSource | null | undefined,
  where: string,
): ParlerDescFields | undefined {
  const fields = pickParlerDescFields(source);
  if (!fields) return undefined;
  assertParlerDescFieldsConsistent(fields, where);
  const conditioning = pickConditioningFields(source);
  validateConditioning(setup.engineType, conditioning);
  assertPerCallConditioning(setup.engineType, conditioning, where);
  const hasDescription = PARLER_DESCRIPTION_KEYS.some(
    (key) => fields[key] != null,
  );
  if (!hasDescription && setup.settings.description != null) {
    throw new Error(
      `tts-ggml: ${where}: per-call template options cannot be combined ` +
        "with a constructor-level description; pass a per-call " +
        "description instead",
    );
  }
  return fields;
}

export function buildParlerParams(
  setup: EngineSetup,
): TTSConfigurationParams {
  // Re-checked here (not only in the constructor) so reload({...}) cannot
  // smuggle in a description/template conflict.
  if (setup.settings.description != null) {
    const templateSet = [
      setup.settings.voice,
      setup.settings.emotion,
      setup.settings.pitch,
      setup.settings.pace,
      setup.settings.expressivity,
      setup.settings.noise,
      setup.settings.reverb,
      setup.settings.quality,
    ].some((value) => value != null && value !== "");
    if (templateSet) {
      throw new Error(
        "tts-ggml: 'description' is mutually exclusive with the " +
          "voice-template options",
      );
    }
  }
  const parameters: TTSConfigurationParams = {
    engineType: ENGINE_PARLER,
    parlerModelPath: setup.paths.parlerModelPath || "",
  };
  if (setup.settings.description != null) {
    parameters.description = String(setup.settings.description);
  }
  if (setup.settings.voice) parameters.voice = String(setup.settings.voice);
  if (setup.settings.emotion != null) {
    parameters.emotion = String(setup.settings.emotion);
  }
  if (setup.settings.pitch != null) parameters.pitch = String(setup.settings.pitch);
  if (setup.settings.pace != null) parameters.pace = String(setup.settings.pace);
  if (setup.settings.expressivity != null) {
    parameters.expressivity = String(setup.settings.expressivity);
  }
  if (setup.settings.noise != null) parameters.noise = String(setup.settings.noise);
  if (setup.settings.reverb != null) parameters.reverb = String(setup.settings.reverb);
  if (setup.settings.quality != null) {
    parameters.quality = String(setup.settings.quality);
  }
  assignSamplingParams(setup, parameters);
  if (setup.settings.minNewTokens != null) {
    parameters.minNewTokens = setup.settings.minNewTokens | 0;
  }
  if (setup.settings.streamChunkTokens != null) {
    parameters.streamChunkTokens = setup.settings.streamChunkTokens | 0;
  }
  if (setup.settings.streamFirstChunkTokens != null) {
    parameters.streamFirstChunkTokens =
      setup.settings.streamFirstChunkTokens | 0;
  }
  if (setup.settings.normalizeNumbers != null) {
    parameters.normalizeNumbers = !!setup.settings.normalizeNumbers;
  }
  assignBackendParams(setup, parameters);
  return parameters;
}

/** The template and sampler settings a Parler reload may rewrite one by one. */
const PARLER_RELOADABLE_KEYS = [
  "voice",
  "pitch",
  "expressivity",
  "noise",
  "reverb",
  "quality",
  "temperature",
  "topK",
  "topP",
  "maxFrames",
  "minNewTokens",
  "normalizeNumbers",
  "seed",
] as const;

type ParlerReloadConfig = Partial<ParlerDescriptionFields> &
  Partial<Pick<SynthesisSettings, (typeof PARLER_RELOADABLE_KEYS)[number]>>;

/**
 * Parler description/template + sampling knobs are reloadable; they rebuild
 * the engine's default description / sampler. `buildParlerParams`
 * re-validates afterwards, so a description/template conflict introduced by a
 * reload still throws (and the caller rolls the settings back).
 */
export function applyParlerReload(
  setup: EngineSetup,
  newConfig: Record<string, unknown>,
): void {
  if (setup.engineType !== ENGINE_PARLER) return;
  const config = newConfig as ParlerReloadConfig;
  if (
    config.description !== undefined ||
    config.voiceDescription !== undefined
  ) {
    setup.settings.description = firstNonEmpty(
      config.description,
      config.voiceDescription,
    );
  }
  for (const key of PARLER_RELOADABLE_KEYS) {
    const value = config[key];
    if (value !== undefined) Object.assign(setup.settings, { [key]: value });
  }
}
