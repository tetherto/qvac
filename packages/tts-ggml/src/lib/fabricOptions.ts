import type { TTSConfigurationParams } from "../tts";
import type { EngineType } from "./engineIds";

export interface FabricOptions {
  maxNewTokens?: number;
  textTemperature?: number;
  textTopP?: number;
  textTopK?: number;
  audioTemperature?: number;
  audioTopP?: number;
  audioTopK?: number;
  audioRepetitionPenalty?: number;
  coremlDecoder?: boolean;
  coremlComputeUnits?: "all" | "cpu_and_ane" | "cpu_and_gpu" | "cpu_only";
  coremlStrict?: boolean;
  precision?: "auto" | "f32" | "f16" | "q8_0";
  f16Attn?: number;
  f16Weights?: number;
  f16WeightsDenyList?: string[];
  kvAttnType?: number;
  vulkanEnvOverrides?: Record<string, string>;
  voiceStyleTtl?: number[] | Float32Array;
  voiceStyleDp?: number[] | Float32Array;
  forceSpeechTokens?: number[];
}

const ENGINE_OPTION_KEYS = {
  moss: [
    "maxNewTokens", "textTemperature", "textTopP", "textTopK",
    "audioTemperature", "audioTopP", "audioTopK", "audioRepetitionPenalty",
  ],
  parler: ["coremlDecoder", "coremlComputeUnits", "coremlStrict"],
  supertonic: [
    "precision", "f16Attn", "f16Weights", "f16WeightsDenyList", "kvAttnType",
    "vulkanEnvOverrides", "voiceStyleTtl", "voiceStyleDp",
  ],
  cosyvoice3: ["forceSpeechTokens"],
} as const;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INTEGER_KEYS = new Set(["maxNewTokens", "textTopK", "audioTopK", "f16Attn", "f16Weights", "kvAttnType"]);
const BOOLEAN_KEYS = new Set(["coremlDecoder", "coremlStrict"]);
const WEBGPU_ENGINES = ["supertonic", "parler", "cosyvoice3", "audio8"];

function validInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
}

function validateOptionValue(key: string, value: unknown): void {
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
    return;
  }
  if (key === "coremlComputeUnits") {
    if (!["all", "cpu_and_ane", "cpu_and_gpu", "cpu_only"].includes(value as string)) {
      throw new Error("coremlComputeUnits must be all, cpu_and_ane, cpu_and_gpu or cpu_only");
    }
    return;
  }
  if (key === "precision") {
    if (!["auto", "f32", "f16", "q8_0"].includes(value as string)) throw new Error("Invalid precision");
    return;
  }
  if (key === "vulkanEnvOverrides") {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !Object.values(value).every((entry: unknown) => typeof entry === "string")) {
      throw new Error("vulkanEnvOverrides must be an object with string values");
    }
    return;
  }
  if (key === "f16WeightsDenyList") {
    if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === "string")) {
      throw new Error("f16WeightsDenyList must be an array of strings");
    }
    return;
  }
  if (key === "voiceStyleTtl" || key === "voiceStyleDp" || key === "forceSpeechTokens") {
    validateVector(key, value);
    return;
  }
  if (INTEGER_KEYS.has(key)) {
    if (!validInteger(value)) throw new Error(`${key} must be a 32-bit integer`);
  } else if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
}

function validateVector(key: string, value: unknown): void {
  if (!Array.isArray(value) && !(value instanceof Float32Array)) throw new Error(`${key} must be an array`);
  const entries = Array.from(value as number[]);
  const valid = key === "forceSpeechTokens"
    ? entries.every(validInteger)
    : entries.every((entry) => typeof entry === "number" && Number.isFinite(entry));
  if (!valid) throw new Error(`${key} contains an invalid number`);
}

export function validateBackendOption(engine: EngineType, backend: unknown): void {
  if (backend === undefined) return;
  if (typeof backend !== "string") throw new Error("backend must be a string");
  if (/^webgpu/i.test(backend) && !WEBGPU_ENGINES.includes(engine)) {
    throw new Error(`tts-ggml: WebGPU has no established support for ${engine}`);
  }
}

function copyValue(value: unknown): unknown {
  if (Array.isArray(value) || value instanceof Float32Array) return Array.from(value);
  if (value !== null && typeof value === "object") return { ...value };
  return value;
}

export function resolveFabricOptions(
  engine: EngineType,
  options: FabricOptions & { nCtx?: number },
): FabricOptions {
  if (engine === "moss") validateMossCounts(options);
  const result: Record<string, unknown> = {};
  copyEngineOptions(engine, options, result);
  if (engine === "supertonic" && ((options.voiceStyleTtl === undefined) !== (options.voiceStyleDp === undefined))) {
    throw new Error("voiceStyleTtl and voiceStyleDp must be supplied together");
  }
  return result;
}

function validateMossCounts(options: FabricOptions & { nCtx?: number }): void {
  if (options.nCtx !== undefined && (!validInteger(options.nCtx) || options.nCtx < 1)) {
    throw new Error("nCtx must be a positive 32-bit integer for MOSS");
  }
  if (options.maxNewTokens !== undefined && (!validInteger(options.maxNewTokens) || options.maxNewTokens < 1)) {
    throw new Error("maxNewTokens must be a positive 32-bit integer");
  }
}

function copyEngineOptions(
  engine: EngineType,
  options: FabricOptions,
  result: Record<string, unknown>,
): void {
  for (const [owner, keys] of Object.entries(ENGINE_OPTION_KEYS)) {
    for (const key of keys) {
      const value = options[key];
      if (value === undefined) continue;
      if (owner !== engine) throw new Error(`tts-ggml: ${key} is ${owner}-only`);
      validateOptionValue(key, value);
      result[key] = copyValue(value);
    }
  }
}

export function assignFabricOptions(
  settings: FabricOptions,
  parameters: TTSConfigurationParams,
): void {
  for (const keys of Object.values(ENGINE_OPTION_KEYS)) {
    for (const key of keys) {
      const value = settings[key];
      if (value !== undefined) parameters[key] = copyValue(value) as TTSConfigurationParams[string];
    }
  }
}
