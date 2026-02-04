import { z } from "zod";
import {
  llmConfigBaseSchema,
  embedConfigBaseSchema,
  type LlmConfig,
  type EmbedConfig,
} from "./llamacpp-config";
import { whisperConfigSchema } from "./whispercpp-config";
import { delegateSchema } from "./delegate";
import { nmtConfigSchema } from "./translation-config";
import { ttsConfigSchema } from "./text-to-speech";
import { ocrConfigSchema } from "./ocr";
import {
  modelSrcInputSchema,
  modelInputToSrcSchema,
  modelInputToNameSchema,
} from "./model-src-utils";
import {
  llmModelTypeSchema,
  whisperModelTypeSchema,
  embeddingsModelTypeSchema,
  nmtModelTypeSchema,
  ttsModelTypeSchema,
  ocrModelTypeSchema,
  ModelType,
} from "./model-types";
import type { Logger } from "@/logging";
import { reloadConfigRequestSchema } from "./reload-config";

const loadModelOptionsBaseSchema = z.union([
  z.object({
    modelSrc: modelSrcInputSchema,
    modelType: llmModelTypeSchema,
    modelConfig: llmConfigBaseSchema.strict().optional(),
    seed: z.boolean().optional(),
    projectionModelSrc: modelSrcInputSchema.optional(),
    delegate: delegateSchema,
    toolFormat: z.enum(["json", "xml"]).default("json"),
  }),
  z.object({
    modelSrc: modelSrcInputSchema,
    modelType: whisperModelTypeSchema,
    modelConfig: whisperConfigSchema.partial().strict().optional(),
    seed: z.boolean().optional(),
    vadModelSrc: modelSrcInputSchema.optional(),
    delegate: delegateSchema,
  }),
  z.object({
    modelSrc: modelSrcInputSchema,
    modelType: embeddingsModelTypeSchema,
    modelConfig: embedConfigBaseSchema.strict().optional(),
    seed: z.boolean().optional(),
    delegate: delegateSchema,
  }),
  z.object({
    modelSrc: modelSrcInputSchema,
    modelType: nmtModelTypeSchema,
    modelConfig: nmtConfigSchema,
    srcVocabSrc: modelSrcInputSchema.optional(),
    dstVocabSrc: modelSrcInputSchema.optional(),
    seed: z.boolean().optional(),
    delegate: delegateSchema,
  }),
  z.object({
    modelSrc: modelSrcInputSchema,
    modelType: ttsModelTypeSchema,
    modelConfig: ttsConfigSchema,
    configSrc: modelSrcInputSchema,
    eSpeakDataPath: z.string(),
    seed: z.boolean().optional(),
    delegate: delegateSchema,
  }),
  z.object({
    modelSrc: modelSrcInputSchema,
    modelType: ocrModelTypeSchema,
    modelConfig: ocrConfigSchema.partial().strict().optional(),
    detectorModelSrc: modelSrcInputSchema.optional(),
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
      modelType: llmModelTypeSchema,
      modelConfig: llmConfigBaseSchema.strict().optional(),
      seed: z.boolean().optional(),
      projectionModelSrc: modelSrcInputSchema.optional(),
      delegate: delegateSchema,
      toolFormat: z.enum(["json", "xml"]).default("json"),
      onProgress: z.unknown().optional(),
      withProgress: z.boolean().optional(),
    })
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: ModelType.llamacppCompletion,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: (data.modelConfig ?? {}) as LlmConfig,
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
      modelType: whisperModelTypeSchema,
      modelConfig: whisperConfigSchema.partial().strict().optional(),
      seed: z.boolean().optional(),
      vadModelSrc: modelSrcInputSchema.optional(),
      delegate: delegateSchema,
      onProgress: z.unknown().optional(),
      withProgress: z.boolean().optional(),
    })
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: ModelType.whispercppTranscription,
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
      modelType: embeddingsModelTypeSchema,
      modelConfig: embedConfigBaseSchema.strict().optional(),
      seed: z.boolean().optional(),
      delegate: delegateSchema,
      onProgress: z.unknown().optional(),
      withProgress: z.boolean().optional(),
    })
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: ModelType.llamacppEmbedding,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: (data.modelConfig ?? {}) as EmbedConfig,
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
    })),
  z
    .object({
      modelSrc: modelSrcInputSchema,
      modelType: nmtModelTypeSchema,
      modelConfig: nmtConfigSchema,
      srcVocabSrc: modelSrcInputSchema.optional(),
      dstVocabSrc: modelSrcInputSchema.optional(),
      seed: z.boolean().optional(),
      delegate: delegateSchema,
      onProgress: z.unknown().optional(),
      withProgress: z.boolean().optional(),
    })
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: ModelType.nmtcppTranslation,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: data.modelConfig,
      srcVocabSrc: data.srcVocabSrc
        ? modelInputToSrcSchema.parse(data.srcVocabSrc)
        : undefined,
      dstVocabSrc: data.dstVocabSrc
        ? modelInputToSrcSchema.parse(data.dstVocabSrc)
        : undefined,
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
    })),
  z
    .object({
      modelSrc: modelSrcInputSchema,
      modelType: ttsModelTypeSchema,
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
      modelType: ModelType.onnxTts,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: data.modelConfig,
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
      configSrc: modelInputToSrcSchema.parse(data.configSrc),
      eSpeakDataPath: data.eSpeakDataPath,
    })),
  z
    .object({
      modelSrc: modelSrcInputSchema,
      modelType: ocrModelTypeSchema,
      modelConfig: ocrConfigSchema.partial().strict().optional(),
      detectorModelSrc: modelSrcInputSchema.optional(),
      seed: z.boolean().optional(),
      delegate: delegateSchema,
      onProgress: z.unknown().optional(),
      withProgress: z.boolean().optional(),
    })
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: ModelType.onnxOcr,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: (data.modelConfig ?? {}) as z.infer<typeof ocrConfigSchema>,
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
      detectorModelSrc: data.detectorModelSrc
        ? modelInputToSrcSchema.parse(data.detectorModelSrc)
        : undefined,
    })),
]);

const commonModelConfigSchema = z.object({
  type: z.literal("loadModel"),
  modelSrc: z.string(),
  modelName: z.string().optional(),
  projectionModelSrc: z.string().optional(),
  vadModelSrc: z.string().optional(),
  configSrc: z.string().optional(),
  detectorModelSrc: z.string().optional(),
  withProgress: z.boolean().optional(),
  seed: z.boolean().optional(),
  delegate: delegateSchema,
});

// Request schemas for each model type (use canonical types since transforms normalize)
// Use base schemas (no defaults) for client-side validation.
// Server applies device defaults, then full schema defaults.
export const loadLlmModelRequestSchema = commonModelConfigSchema.extend({
  modelType: z.literal(ModelType.llamacppCompletion),
  modelConfig: llmConfigBaseSchema,
});

export const loadWhisperModelRequestSchema = commonModelConfigSchema.extend({
  modelType: z.literal(ModelType.whispercppTranscription),
  modelConfig: whisperConfigSchema, // whisper has no defaults
});

export const loadEmbeddingsModelRequestSchema = commonModelConfigSchema.extend({
  modelType: z.literal(ModelType.llamacppEmbedding),
  modelConfig: embedConfigBaseSchema,
});

export const loadNmtModelRequestSchema = commonModelConfigSchema.extend({
  modelType: z.literal(ModelType.nmtcppTranslation),
  modelConfig: nmtConfigSchema, // nmt has no defaults
  srcVocabSrc: z.string().optional(),
  dstVocabSrc: z.string().optional(),
});

export const loadTtsModelRequestSchema = commonModelConfigSchema.extend({
  modelType: z.literal(ModelType.onnxTts),
  modelConfig: ttsConfigSchema, // tts has no defaults
  configSrc: z.string(),
  eSpeakDataPath: z.string(),
});

export const loadOcrModelRequestSchema = commonModelConfigSchema.extend({
  modelType: z.literal(ModelType.onnxOcr),
  modelConfig: ocrConfigSchema, // ocr has no defaults
});

// Union of all load model request types (using z.union since each modelType accepts multiple values)
export const loadModelSrcRequestSchema = z
  .union([
    loadLlmModelRequestSchema,
    loadWhisperModelRequestSchema,
    loadEmbeddingsModelRequestSchema,
    loadNmtModelRequestSchema,
    loadTtsModelRequestSchema,
    loadOcrModelRequestSchema,
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
  detectorModelPath: z.string().optional(),
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
