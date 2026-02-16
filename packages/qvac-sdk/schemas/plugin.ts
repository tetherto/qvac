import { z } from "zod";

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
  /** The handler function - receives validated request, returns validated response */
  handler: TRequest extends z.ZodType<infer I>
    ? TResponse extends z.ZodType<infer O>
      ? (request: I) => Promise<O> | AsyncGenerator<O>
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
 * - `ttsConfigModelPath` - TTS config.json path
 * - `eSpeakDataPath` - TTS eSpeak data directory
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

export interface QvacPlugin {
  modelType: string;
  displayName: string;
  addonPackage: string;
  createModel: (params: CreateModelParams) => PluginModelResult;
  handlers: Record<string, PluginHandlerDefinition>;
  logging?: PluginLogging | undefined;
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
    createModel: functionRuntimeSchema,
    handlers: z.record(z.string(), pluginHandlerDefinitionRuntimeSchema),
    logging: z
      .object({
        module: z.unknown().optional(),
        namespace: z.string().optional(),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown());
