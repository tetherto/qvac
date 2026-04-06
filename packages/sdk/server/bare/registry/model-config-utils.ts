import type { ZodSchema } from "zod";
import {
  ModelType,
  type CanonicalModelType,
  type DevicePattern,
  type DeviceMatch,
  type RuntimeContext,
} from "@/schemas";
import { llmConfigSchema, embedConfigSchema } from "@/schemas/llamacpp-config";
import {
  whisperConfigSchema,
  parakeetRuntimeConfigSchema,
} from "@/schemas/transcription-config";
import { ocrConfigSchema } from "@/schemas/ocr";
import { sdcppConfigSchema } from "@/schemas/sdcpp-config";

export const CANONICAL_TO_ALIAS: Record<CanonicalModelType, string> = {
  [ModelType.llamacppCompletion]: "llm",
  [ModelType.llamacppEmbedding]: "embeddings",
  [ModelType.whispercppTranscription]: "whisper",
  [ModelType.parakeetTranscription]: "parakeet",
  [ModelType.nmtcppTranslation]: "nmt",
  [ModelType.onnxTts]: "tts",
  [ModelType.onnxOcr]: "ocr",
  [ModelType.sdcppGeneration]: "diffusion",
};

export const MODEL_CONFIG_SCHEMAS: Partial<
  Record<CanonicalModelType, ZodSchema>
> = {
  [ModelType.llamacppCompletion]: llmConfigSchema,
  [ModelType.llamacppEmbedding]: embedConfigSchema,
  [ModelType.whispercppTranscription]: whisperConfigSchema,
  [ModelType.parakeetTranscription]: parakeetRuntimeConfigSchema.passthrough(),
  [ModelType.onnxOcr]: ocrConfigSchema,
  [ModelType.sdcppGeneration]: sdcppConfigSchema,
};

// Ordered general → specific (later patterns override earlier)
export const BUILTIN_DEVICE_PATTERNS: DevicePattern[] = [
  {
    name: "Android devices (SDK default)",
    match: {
      platform: "android",
    },
    defaults: {
      [ModelType.llamacppEmbedding]: { flashAttention: "off" },
    },
  },
  {
    name: "Pixel devices (SDK default)",
    match: {
      platform: "android",
      deviceBrand: "google",
      deviceModelPrefix: "Pixel",
    },
    defaults: {
      [ModelType.llamacppCompletion]: { device: "cpu" },
      [ModelType.llamacppEmbedding]: { device: "cpu" },
    },
  },
];

export function matchesPattern(
  ctx: RuntimeContext,
  match: DeviceMatch,
): boolean {
  if (match.platform !== undefined && ctx.platform !== match.platform) {
    return false;
  }
  if (
    match.deviceBrand !== undefined &&
    ctx.deviceBrand?.toLowerCase() !== match.deviceBrand.toLowerCase()
  ) {
    return false;
  }
  if (
    match.deviceModelPrefix !== undefined &&
    !(ctx.deviceModel?.startsWith(match.deviceModelPrefix) ?? false)
  ) {
    return false;
  }
  if (
    match.deviceModelContains !== undefined &&
    !(ctx.deviceModel?.includes(match.deviceModelContains) ?? false)
  ) {
    return false;
  }
  return true;
}

export function findAllMatchingPatterns(
  ctx: RuntimeContext,
  patterns: DevicePattern[],
): DevicePattern[] {
  return patterns.filter((pattern) => matchesPattern(ctx, pattern.match));
}

export function getDefaultsFromPattern(
  modelType: CanonicalModelType,
  pattern: DevicePattern,
): Record<string, unknown> | undefined {
  let defaults = pattern.defaults[
    modelType as keyof typeof pattern.defaults
  ] as Record<string, unknown> | undefined;

  if (!defaults) {
    const aliasKey = CANONICAL_TO_ALIAS[modelType];
    if (aliasKey && aliasKey in pattern.defaults) {
      defaults = pattern.defaults[aliasKey as keyof typeof pattern.defaults] as
        | Record<string, unknown>
        | undefined;
    }
  }

  return defaults;
}

export type ConfigResolutionLog = {
  appliedPatterns: string[];
  mergedDefaults: Record<string, unknown>;
  finalConfig: Record<string, unknown>;
};

export function resolveModelConfigWithContext<T>(
  modelType: CanonicalModelType,
  userInput: Record<string, unknown>,
  ctx: RuntimeContext,
  userPatterns: DevicePattern[],
  builtinPatterns: DevicePattern[] = BUILTIN_DEVICE_PATTERNS,
  onLog?: (log: ConfigResolutionLog) => void,
): T {
  // Find ALL matching patterns (general → specific order preserved)
  const matchingBuiltin = findAllMatchingPatterns(ctx, builtinPatterns);
  const matchingUser = findAllMatchingPatterns(ctx, userPatterns);

  // Merge in order: builtin patterns → user patterns → user input
  // Later values override earlier (more specific wins)
  const appliedPatterns: string[] = [];
  let mergedDefaults: Record<string, unknown> = {};

  for (const pattern of matchingBuiltin) {
    const defaults = getDefaultsFromPattern(modelType, pattern);
    if (defaults) {
      appliedPatterns.push(pattern.name);
      mergedDefaults = { ...mergedDefaults, ...defaults };
    }
  }

  for (const pattern of matchingUser) {
    const defaults = getDefaultsFromPattern(modelType, pattern);
    if (defaults) {
      appliedPatterns.push(pattern.name);
      mergedDefaults = { ...mergedDefaults, ...defaults };
    }
  }

  const merged = {
    ...mergedDefaults,
    ...userInput,
  };

  const schema = MODEL_CONFIG_SCHEMAS[modelType];
  const finalConfig = schema ? schema.parse(merged) : merged;

  if (onLog) {
    onLog({
      appliedPatterns,
      mergedDefaults,
      finalConfig: finalConfig as Record<string, unknown>,
    });
  }

  return finalConfig as T;
}
