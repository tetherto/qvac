import { z } from "zod";
import { llmConfigSchema, embedConfigSchema } from "./llamacpp-config";
import { whisperConfigSchema } from "./whispercpp-config";
import { delegateSchema } from "./delegate";
import { nmtConfigSchema } from "./translation-config";
import { ttsConfigSchema } from "./text-to-speech";
import {
  modelSrcInputSchema,
  modelInputToSrcSchema,
  modelInputToNameSchema,
} from "./model-src-utils";
import type { Logger } from "@/logging";
import { reloadConfigRequestSchema } from "./reload-config";

const loadModelOptionsBaseSchema = z.union([
  z.object({
    modelSrc: modelSrcInputSchema,
    modelType: z.literal("llm"),
    modelConfig: llmConfigSchema.partial().strict().optional(),
    seed: z.boolean().optional(),
    projectionModelSrc: modelSrcInputSchema.optional(),
    delegate: delegateSchema,
    toolFormat: z.enum(["json", "xml"]).default("json"),
  }),
  z.object({
    modelSrc: modelSrcInputSchema,
    modelType: z.literal("whisper"),
    modelConfig: whisperConfigSchema.partial().strict().optional(),
    seed: z.boolean().optional(),
    vadModelSrc: modelSrcInputSchema.optional(),
    delegate: delegateSchema,
  }),
  z.object({
    modelSrc: modelSrcInputSchema,
    modelType: z.literal("embeddings"),
    modelConfig: embedConfigSchema.partial().strict().optional(),
    seed: z.boolean().optional(),
    delegate: delegateSchema,
  }),
  z.object({
    modelSrc: modelSrcInputSchema,
    modelType: z.literal("nmt"),
    modelConfig: nmtConfigSchema,
    seed: z.boolean().optional(),
    delegate: delegateSchema,
  }),
  z.object({
    modelSrc: modelSrcInputSchema,
    modelType: z.literal("tts"),
    modelConfig: ttsConfigSchema,
    configSrc: modelSrcInputSchema,
    eSpeakDataPath: z.string(),
    seed: z.boolean().optional(),
    delegate: delegateSchema,
  }),
]);

export const loadModelOptionsSchema = loadModelOptionsBaseSchema.transform(
  (data) => ({
    ...data,
    seed: data.seed ?? false,
  }),
);

export const loadModelOptionsToRequestSchema = z.union([
  z
    .object({
      modelSrc: modelSrcInputSchema,
      modelType: z.literal("llm"),
      modelConfig: llmConfigSchema.partial().strict().optional(),
      seed: z.boolean().optional(),
      projectionModelSrc: modelSrcInputSchema.optional(),
      delegate: delegateSchema,
      toolFormat: z.enum(["json", "xml"]).default("json"),
      onProgress: z.unknown().optional(),
      withProgress: z.boolean().optional(),
    })
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: "llm" as const,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: (data.modelConfig ?? {}) as z.infer<typeof llmConfigSchema>,
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
      projectionModelSrc: data.projectionModelSrc
        ? modelInputToSrcSchema.parse(data.projectionModelSrc)
        : undefined,
    })),
  z
    .object({
      modelSrc: modelSrcInputSchema,
      modelType: z.literal("whisper"),
      modelConfig: whisperConfigSchema.partial().strict().optional(),
      seed: z.boolean().optional(),
      vadModelSrc: modelSrcInputSchema.optional(),
      delegate: delegateSchema,
      onProgress: z.unknown().optional(),
      withProgress: z.boolean().optional(),
    })
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: "whisper" as const,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: (data.modelConfig ?? {}) as z.infer<
        typeof whisperConfigSchema
      >,
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
      vadModelSrc: data.vadModelSrc
        ? modelInputToSrcSchema.parse(data.vadModelSrc)
        : undefined,
    })),
  z
    .object({
      modelSrc: modelSrcInputSchema,
      modelType: z.literal("embeddings"),
      modelConfig: embedConfigSchema.partial().strict().optional(),
      seed: z.boolean().optional(),
      delegate: delegateSchema,
      onProgress: z.unknown().optional(),
      withProgress: z.boolean().optional(),
    })
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: "embeddings" as const,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: (data.modelConfig ?? {}) as z.infer<
        typeof embedConfigSchema
      >,
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
    })),
  z
    .object({
      modelSrc: modelSrcInputSchema,
      modelType: z.literal("nmt"),
      modelConfig: nmtConfigSchema,
      seed: z.boolean().optional(),
      delegate: delegateSchema,
      onProgress: z.unknown().optional(),
      withProgress: z.boolean().optional(),
    })
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: "nmt" as const,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: data.modelConfig,
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
    })),
  z
    .object({
      modelSrc: modelSrcInputSchema,
      modelType: z.literal("tts"),
      modelConfig: ttsConfigSchema,
      configSrc: modelSrcInputSchema,
      eSpeakDataPath: z.string(),
      seed: z.boolean().optional(),
      delegate: delegateSchema,
      onProgress: z.unknown().optional(),
      withProgress: z.boolean().optional(),
    })
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: "tts" as const,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: data.modelConfig,
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
      configSrc: modelInputToSrcSchema.parse(data.configSrc),
      eSpeakDataPath: data.eSpeakDataPath,
    })),
]);

const commonModelConfigSchema = z.object({
  type: z.literal("loadModel"),
  modelSrc: z.string(),
  modelName: z.string().optional(),
  projectionModelSrc: z.string().optional(),
  vadModelSrc: z.string().optional(),
  configSrc: z.string().optional(),
  withProgress: z.boolean().optional(),
  seed: z.boolean().optional(),
  delegate: delegateSchema,
});

// Request schemas for each model type
export const loadLlmModelRequestSchema = commonModelConfigSchema.extend({
  modelType: z.literal("llm"),
  modelConfig: llmConfigSchema,
});

export const loadWhisperModelRequestSchema = commonModelConfigSchema.extend({
  modelType: z.literal("whisper"),
  modelConfig: whisperConfigSchema,
});

export const loadEmbeddingsModelRequestSchema = commonModelConfigSchema.extend({
  modelType: z.literal("embeddings"),
  modelConfig: embedConfigSchema,
});

export const loadNmtModelRequestSchema = commonModelConfigSchema.extend({
  modelType: z.literal("nmt"),
  modelConfig: nmtConfigSchema,
});

export const loadTtsModelRequestSchema = commonModelConfigSchema.extend({
  modelType: z.literal("tts"),
  modelConfig: ttsConfigSchema,
  configSrc: z.string(),
  eSpeakDataPath: z.string(),
});

// Union of all load model request types
export const loadModelSrcRequestSchema = z
  .discriminatedUnion("modelType", [
    loadLlmModelRequestSchema,
    loadWhisperModelRequestSchema,
    loadEmbeddingsModelRequestSchema,
    loadNmtModelRequestSchema,
    loadTtsModelRequestSchema,
  ])
  .transform((data) => ({
    ...data,
    seed: data.seed ?? false,
  }));

// Combined request schema: load new model OR reload config
export const loadModelRequestSchema = z.union([
  loadModelSrcRequestSchema,
  reloadConfigRequestSchema,
]);

export const loadModelResponseSchema = z.object({
  type: z.literal("loadModel"),
  success: z.boolean(),
  modelId: z.string().optional(),
  error: z.string().optional(),
});

export const modelProgressUpdateSchema = z.object({
  type: z.literal("modelProgress"),
  downloaded: z.number(),
  total: z.number(),
  percentage: z.number(),
  downloadKey: z.string(),
  shardInfo: z
    .object({
      currentShard: z.number(),
      totalShards: z.number(),
      shardName: z.string(),
      overallDownloaded: z.number(),
      overallTotal: z.number(),
      overallPercentage: z.number(),
    })
    .optional(),
});

export const hyperdriveUrlSchema = z
  .string()
  .regex(
    /^pear:\/\/[0-9a-fA-F]{64}\/(.+)$/,
    "Invalid hyperdrive URL. Expected format: pear://64-char-hex-key/path/to/model.gguf",
  )
  .transform((url) => {
    const match = url.match(/^pear:\/\/([0-9a-fA-F]{64})\/(.+)$/)!;
    return { key: match[1]!, path: match[2]! };
  });

export const loadModelServerParamsSchema = z.object({
  modelId: z.string(),
  modelPath: z.string(),
  options: loadModelOptionsSchema,
  projectionModelPath: z.string().optional(),
  vadModelPath: z.string().optional(),
  ttsConfigModelPath: z.string().optional(),
  eSpeakDataPath: z.string().optional(),
  modelName: z.string().optional(),
});

export type LoadModelServerParams = z.input<typeof loadModelServerParamsSchema>;
export type LoadModelSrcRequest = z.infer<typeof loadModelSrcRequestSchema>;
export type LoadModelRequest = z.infer<typeof loadModelRequestSchema>;
export type LoadModelResponse = z.infer<typeof loadModelResponseSchema>;
export type ModelProgressUpdate = z.infer<typeof modelProgressUpdateSchema>;
export type LoadModelOptions = z.input<typeof loadModelOptionsSchema> & {
  onProgress?: (progress: ModelProgressUpdate) => void;
  logger?: Logger;
};
