import { z } from "zod";
import type { ModelSrcInput } from "./model-src-utils";

/**
 * Definition for a plugin handler with explicit Zod schemas.
 * Each handler must define its request/response schemas for validation.
 */
export interface PluginHandlerDefinition<
  TRequest extends z.ZodType = z.ZodType,
  TResponse extends z.ZodType = z.ZodType,
> {
  requestSchema: TRequest;
  responseSchema: TResponse;
  streaming: boolean;
  duplex?: boolean;
  handler: TRequest extends z.ZodType<infer I>
    ? TResponse extends z.ZodType<infer O>
      ? (
          request: I,
          inputStream?: AsyncIterable<Buffer>,
        ) => Promise<O> | AsyncGenerator<O>
      : never
    : never;
}

/**
 * Variant of `PluginHandlerDefinition` for duplex handlers where
 * `inputStream` is guaranteed to be present. Use with `defineDuplexHandler`.
 */
export interface DuplexPluginHandlerDefinition<
  TRequest extends z.ZodType = z.ZodType,
  TResponse extends z.ZodType = z.ZodType,
> {
  requestSchema: TRequest;
  responseSchema: TResponse;
  streaming: true;
  duplex: true;
  handler: TRequest extends z.ZodType<infer I>
    ? TResponse extends z.ZodType<infer O>
      ? (
          request: I,
          inputStream: AsyncIterable<Buffer>,
        ) => AsyncGenerator<O>
      : never
    : never;
}

/**
 * Parameters passed to createModel when loading a plugin model.
 *
 * Core fields are always present. The `artifacts` map contains
 * additional file paths required by specific plugins (e.g., projection
 * models, VAD models, config files).
 *
 * Built-in artifact keys:
 * - `projectionModelPath` - LLM multimodal projection model
 * - `vadModelPath` - Whisper voice activity detection model
 * - `tokenizerPath`, `speechEncoderPath`, `embedTokensPath`, `conditionalDecoderPath`, `languageModelPath` - TTS (Chatterbox) model files
 * - `referenceAudioPath` - TTS (Chatterbox) path to reference WAV file for voice cloning
 * - `tokenizerPath`, `textEncoderPath`, `latentDenoiserPath`, `voiceDecoderPath` - TTS (Supertonic) model files
 * - `voicePath` - TTS (Supertonic) path to voice .bin file (e.g. voices/M1.bin)
 * - `speed`, `numInferenceSteps` - TTS (Supertonic) options
 * - `detectorModelPath` - OCR detector model
 *
 * Custom plugins can define their own artifact keys.
 */
export interface CreateModelParams {
  modelId: string;
  modelPath: string;
  modelConfig?: Record<string, unknown> | undefined;
  modelName?: string | undefined;
  artifacts?: Record<string, string> | undefined;
}

/**
 * Minimal contract for plugin models.
 * All models must implement `load()`. `unload()` is optional.
 */
export interface PluginModel {
  load(force?: boolean): Promise<void>;
  unload?(): void | Promise<void>;
}

export interface PluginModelResult {
  model: PluginModel;
  loader: unknown;
}

export interface PluginLogging {
  module: unknown;
  namespace: string;
}

/**
 * Function to resolve a model source (URL or path) to a local file path.
 * Passed to resolveConfig hook to allow plugins to resolve their artifacts.
 */
export type ResolveModelPath = (src: ModelSrcInput) => Promise<string>;

/**
 * Context passed to plugin resolveConfig hook.
 * Provides resolution utilities and request metadata.
 */
export interface ResolveContext {
  resolveModelPath: ResolveModelPath;
  modelSrc: string;
  modelType: string;
  modelName?: string;
}

/**
 * Result from plugin resolveConfig hook.
 * Contains transformed config and optional resolved artifacts.
 */
export interface ResolveResult<
  TConfig = Record<string, unknown>,
  K extends string = string,
> {
  config: TConfig;
  artifacts?: Partial<Record<K, string>>;
}

export interface QvacPlugin<
  TConfig = Record<string, unknown>,
  TArtifactKeys extends string = string,
> {
  modelType: string;
  displayName: string;
  addonPackage: string;
  loadConfigSchema: z.ZodType;
  createModel: (params: CreateModelParams) => PluginModelResult;
  handlers: Record<string, PluginHandlerDefinition>;
  logging?: PluginLogging | undefined;
  /** When true, skips file-existence validation for modelPath. Use for plugins that derive paths from config. */
  skipPrimaryModelPathValidation?: boolean;
  /**
   * Optional hook to resolve model sources in modelConfig to local paths.
   * Called before createModel if the plugin needs to download/resolve artifacts.
   * Returns transformed config and optional artifact paths.
   */
  resolveConfig?: (
    modelConfig: TConfig,
    ctx: ResolveContext,
  ) => Promise<ResolveResult<TConfig, TArtifactKeys>>;
}

// Non-streaming plugin invoke
export const pluginInvokeRequestSchema = z.object({
  type: z.literal("pluginInvoke"),
  modelId: z.string(),
  handler: z.string(),
  params: z.unknown(),
});

export const pluginInvokeResponseSchema = z.object({
  type: z.literal("pluginInvoke"),
  result: z.unknown(),
});

// Streaming plugin invoke
export const pluginInvokeStreamRequestSchema = z.object({
  type: z.literal("pluginInvokeStream"),
  modelId: z.string(),
  handler: z.string(),
  params: z.unknown(),
});

export const pluginInvokeStreamResponseSchema = z.object({
  type: z.literal("pluginInvokeStream"),
  result: z.unknown(),
  done: z.boolean().optional(),
});

export type PluginInvokeRequest = z.infer<typeof pluginInvokeRequestSchema>;
export type PluginInvokeResponse = z.infer<typeof pluginInvokeResponseSchema>;
export type PluginInvokeStreamRequest = z.infer<
  typeof pluginInvokeStreamRequestSchema
>;
export type PluginInvokeStreamResponse = z.infer<
  typeof pluginInvokeStreamResponseSchema
>;

// ============================================
// Type Helpers
// ============================================

/**
 * Helper function to define a plugin with full type inference.
 * This is an identity function that provides type checking.
 */
export function definePlugin<T extends QvacPlugin>(plugin: T): T {
  return plugin;
}

/**
 * Helper function to define a handler with full type inference.
 * This is an identity function that provides type checking.
 */
export function defineHandler<
  TRequest extends z.ZodType,
  TResponse extends z.ZodType,
>(
  definition: PluginHandlerDefinition<TRequest, TResponse>,
): PluginHandlerDefinition<TRequest, TResponse> {
  return definition;
}

export function defineDuplexHandler<
  TRequest extends z.ZodType,
  TResponse extends z.ZodType,
>(
  definition: DuplexPluginHandlerDefinition<TRequest, TResponse>,
): PluginHandlerDefinition<TRequest, TResponse> {
  // The duplex flag guarantees inputStream is always
  // provided at call time; the cast bridges TS function-param contravariance.
  return definition as unknown as PluginHandlerDefinition<TRequest, TResponse>;
}

// ============================================
// Worker runtime validation
// ============================================

const functionRuntimeSchema = z.instanceof(Function, {
  error: "must be a function",
});

const zodSchemaLikeRuntimeSchema = z
  .object({
    safeParse: functionRuntimeSchema,
  })
  .catchall(z.unknown());

export const pluginHandlerDefinitionRuntimeSchema = z
  .object({
    requestSchema: zodSchemaLikeRuntimeSchema,
    responseSchema: zodSchemaLikeRuntimeSchema,
    streaming: z.boolean({ error: "streaming must be a boolean" }),
    duplex: z.boolean().optional(),
    handler: functionRuntimeSchema,
  })
  .catchall(z.unknown());

export const pluginDefinitionRuntimeSchema = z
  .object({
    modelType: z
      .string({ error: "modelType must be a string" })
      .min(1, "modelType must be a non-empty string"),
    displayName: z
      .string({ error: "displayName must be a string" })
      .min(1, "displayName must be a non-empty string"),
    addonPackage: z
      .string({ error: "addonPackage must be a string" })
      .min(1, "addonPackage must be a non-empty string"),
    loadConfigSchema: zodSchemaLikeRuntimeSchema,
    createModel: functionRuntimeSchema,
    handlers: z.record(z.string(), pluginHandlerDefinitionRuntimeSchema),
    logging: z
      .object({
        module: z.unknown().optional(),
        namespace: z.string().optional(),
      })
      .catchall(z.unknown())
      .optional(),
    resolveConfig: functionRuntimeSchema.optional(),
    skipPrimaryModelPathValidation: z.boolean().optional(),
  })
  .catchall(z.unknown());

// ============================================
// Built-in Plugins
// ============================================

/**
 * LLM text completion plugin (llama.cpp).
 * Provides: completion, streaming chat, tool calling.
 */
export const PLUGIN_LLM = "@qvac/sdk/llamacpp-completion/plugin" as const;

/**
 * Text embedding plugin (llama.cpp).
 * Provides: vector embeddings for RAG and semantic search.
 */
export const PLUGIN_EMBEDDING = "@qvac/sdk/llamacpp-embedding/plugin" as const;

/**
 * Speech-to-text transcription plugin (whisper.cpp).
 * Provides: audio transcription, language detection.
 */
export const PLUGIN_WHISPER =
  "@qvac/sdk/whispercpp-transcription/plugin" as const;

/**
 * Speech-to-text transcription plugin (Parakeet ONNX).
 * Provides: audio transcription using NVIDIA Parakeet models.
 */
export const PLUGIN_PARAKEET =
  "@qvac/sdk/parakeet-transcription/plugin" as const;

/**
 * Neural machine translation plugin (nmt.cpp).
 * Provides: text translation between languages.
 */
export const PLUGIN_NMT = "@qvac/sdk/nmtcpp-translation/plugin" as const;

/**
 * Text-to-speech synthesis plugin (ONNX).
 * Provides: speech synthesis from text.
 */
export const PLUGIN_TTS = "@qvac/sdk/onnx-tts/plugin" as const;

/**
 * Optical character recognition plugin (ONNX).
 * Provides: text extraction from images.
 */
export const PLUGIN_OCR = "@qvac/sdk/onnx-ocr/plugin" as const;

/**
 * Image generation plugin (stable-diffusion.cpp).
 * Provides: text-to-image generation.
 */
export const PLUGIN_DIFFUSION =
  "@qvac/sdk/sdcpp-generation/plugin" as const;

/**
 * All built-in SDK plugins.
 *
 * @example
 * // Use all defaults plus a custom plugin:
 * const config = {
 *   plugins: [...SDK_DEFAULT_PLUGINS, myCustomPlugin],
 * };
 */
export const SDK_DEFAULT_PLUGINS = [
  PLUGIN_LLM,
  PLUGIN_EMBEDDING,
  PLUGIN_WHISPER,
  PLUGIN_PARAKEET,
  PLUGIN_NMT,
  PLUGIN_TTS,
  PLUGIN_OCR,
  PLUGIN_DIFFUSION,
] as const;

export type BuiltinPlugin = (typeof SDK_DEFAULT_PLUGINS)[number];

// ============================================
// Addon Packages
// ============================================

/** Native addon package for LLM completion (llama.cpp) */
export const ADDON_LLM = "@qvac/llm-llamacpp" as const;

/** Native addon package for text embeddings (llama.cpp) */
export const ADDON_EMBEDDING = "@qvac/embed-llamacpp" as const;

/** Native addon package for Whisper transcription (whisper.cpp) */
export const ADDON_WHISPER = "@qvac/transcription-whispercpp" as const;

/** Native addon package for Parakeet transcription (ONNX) */
export const ADDON_PARAKEET = "@qvac/transcription-parakeet" as const;

/** Native addon package for NMT translation (nmt.cpp) */
export const ADDON_NMT = "@qvac/translation-nmtcpp" as const;

/** Native addon package for TTS (ONNX) */
export const ADDON_TTS = "@qvac/tts-onnx" as const;

/** Native addon package for OCR (ONNX) */
export const ADDON_OCR = "@qvac/ocr-onnx" as const;

/** Native addon package for image generation (stable-diffusion.cpp) */
export const ADDON_DIFFUSION = "@qvac/diffusion-cpp" as const;
