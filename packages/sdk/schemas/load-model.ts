import { z } from "zod";
import {
  llmConfigBaseSchema,
  embedConfigBaseSchema,
  type LlmConfig,
  type EmbedConfig,
} from "./llamacpp-config";
import {
  whisperConfigSchema,
  parakeetConfigSchema,
} from "./transcription-config";
import { delegateSchema } from "./delegate";
import { nmtConfigSchema } from "./translation-config";
import { ttsConfigSchema } from "./text-to-speech";
import { ocrConfigSchema } from "./ocr";
import {
  modelSrcInputSchema,
  modelInputToSrcSchema,
  modelInputToNameSchema,
  type ModelDescriptor,
} from "./model-src-utils";
import {
  llmModelTypeSchema,
  whisperModelTypeSchema,
  parakeetModelTypeSchema,
  embeddingsModelTypeSchema,
  nmtModelTypeSchema,
  ttsModelTypeSchema,
  ocrModelTypeSchema,
  diffusionModelTypeSchema,
  ModelType,
  ModelTypeAliases,
  type CanonicalModelType,
  type ModelTypeInput,
} from "./model-types";
import { sdcppConfigSchema } from "./sdcpp-config";

// Set of all built-in model types (canonical + aliases) for catch-all exclusion
const builtInModelTypes = new Set([
  ...Object.values(ModelType),
  ...Object.keys(ModelTypeAliases),
]);
import type { Logger } from "@/logging";
import { reloadConfigRequestSchema } from "./reload-config";

const loadModelCommonFields = {
  modelSrc: modelSrcInputSchema,
  seed: z.boolean().optional(),
  delegate: delegateSchema,
};

const loadModelRequestCommonFields = {
  ...loadModelCommonFields,
  onProgress: z.unknown().optional(),
  logger: z.unknown().optional(),
  withProgress: z.boolean().optional(),
};

export const loadBuiltinModelOptionsBaseSchema = z.union([
  z
    .object({
      ...loadModelCommonFields,
      modelType: llmModelTypeSchema,
      modelConfig: llmConfigBaseSchema.strict().optional(),
    })
    .strict(),
  z
    .object({
      ...loadModelCommonFields,
      modelType: whisperModelTypeSchema,
      modelConfig: whisperConfigSchema.partial().strict().optional(),
    })
    .strict(),
  z
    .object({
      ...loadModelCommonFields,
      modelType: parakeetModelTypeSchema,
      modelConfig: parakeetConfigSchema,
    })
    .strict(),
  z
    .object({
      ...loadModelCommonFields,
      modelType: embeddingsModelTypeSchema,
      modelConfig: embedConfigBaseSchema.strict().optional(),
    })
    .strict(),
  z
    .object({
      ...loadModelCommonFields,
      modelType: nmtModelTypeSchema,
      modelConfig: nmtConfigSchema,
    })
    .strict(),
  z
    .object({
      ...loadModelCommonFields,
      modelType: ttsModelTypeSchema,
      modelConfig: ttsConfigSchema,
    })
    .strict(),
  z
    .object({
      ...loadModelCommonFields,
      modelType: ocrModelTypeSchema,
      modelConfig: ocrConfigSchema.partial().strict().optional(),
    })
    .strict(),
  z
    .object({
      ...loadModelCommonFields,
      modelType: diffusionModelTypeSchema,
      modelConfig: sdcppConfigSchema.strict().optional(),
    })
    .strict(),
]);

// Custom plugin catch-all: any modelType string EXCEPT built-ins.
export const loadCustomPluginModelOptionsBaseSchema = z.object({
  ...loadModelCommonFields,
  modelType: z.string().refine((val) => !builtInModelTypes.has(val), {
    message: "Built-in model types must use their specific schema",
  }),
  modelConfig: z.record(z.string(), z.unknown()).optional(),
});

export const loadModelOptionsBaseSchema = z.union([
  loadBuiltinModelOptionsBaseSchema,
  loadCustomPluginModelOptionsBaseSchema,
]);

export const loadModelOptionsSchema = loadModelOptionsBaseSchema.transform(
  (data) => ({
    ...data,
    seed: data.seed ?? false,
  }),
);

const loadModelOptionsToRequestBaseSchema = z.union([
  z
    .object({
      ...loadModelRequestCommonFields,
      modelType: llmModelTypeSchema,
      modelConfig: llmConfigBaseSchema.strict().optional(),
    })
    .strict()
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: ModelType.llamacppCompletion,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: (data.modelConfig ?? {}) as LlmConfig,
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
    })),
  z
    .object({
      ...loadModelRequestCommonFields,
      modelType: whisperModelTypeSchema,
      modelConfig: whisperConfigSchema.partial().strict().optional(),
    })
    .strict()
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: ModelType.whispercppTranscription,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: (data.modelConfig ?? {}),
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
    })),
  z
    .object({
      ...loadModelRequestCommonFields,
      modelType: parakeetModelTypeSchema,
      modelConfig: parakeetConfigSchema,
    })
    .strict()
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: ModelType.parakeetTranscription,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: data.modelConfig,
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
    })),
  z
    .object({
      ...loadModelRequestCommonFields,
      modelType: embeddingsModelTypeSchema,
      modelConfig: embedConfigBaseSchema.strict().optional(),
    })
    .strict()
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
      ...loadModelRequestCommonFields,
      modelType: nmtModelTypeSchema,
      modelConfig: nmtConfigSchema,
    })
    .strict()
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: ModelType.nmtcppTranslation,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig:
        data.modelConfig.engine === "Bergamot" && data.modelConfig.pivotModel
          ? {
              ...data.modelConfig,
              pivotModel: {
                ...data.modelConfig.pivotModel,
                modelSrc: modelInputToSrcSchema.parse(
                  data.modelConfig.pivotModel.modelSrc,
                ),
              },
            }
          : data.modelConfig,
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
    })),
  z
    .object({
      ...loadModelRequestCommonFields,
      modelType: ttsModelTypeSchema,
      modelConfig: ttsConfigSchema,
    })
    .strict()
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: ModelType.onnxTts,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: data.modelConfig,
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
    })),
  z
    .object({
      ...loadModelRequestCommonFields,
      modelType: ocrModelTypeSchema,
      modelConfig: ocrConfigSchema.partial().strict().optional(),
    })
    .strict()
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: ModelType.onnxOcr,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: (data.modelConfig ?? {}),
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
    })),
  z
    .object({
      ...loadModelRequestCommonFields,
      modelType: diffusionModelTypeSchema,
      modelConfig: sdcppConfigSchema.strict().optional(),
    })
    .strict()
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: ModelType.sdcppGeneration,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: data.modelConfig ?? {},
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
    })),
  z
    .object({
      ...loadModelRequestCommonFields,
      modelType: z.string().refine((val) => !builtInModelTypes.has(val), {
        message: "Built-in model types must use their specific schema",
      }),
      modelConfig: z.record(z.string(), z.unknown()).optional(),
    })
    .transform((data) => ({
      type: "loadModel" as const,
      modelType: data.modelType,
      modelSrc: modelInputToSrcSchema.parse(data.modelSrc),
      modelName: modelInputToNameSchema.parse(data.modelSrc),
      modelConfig: data.modelConfig ?? {},
      seed: data.seed ?? false,
      withProgress: data.withProgress ?? !!data.onProgress,
      delegate: data.delegate,
    })),
]);

export const loadModelOptionsToRequestSchema =
  loadModelOptionsToRequestBaseSchema;

const commonModelConfigSchema = z.object({
  type: z.literal("loadModel"),
  modelSrc: z.string(),
  modelName: z.string().optional(),
  withProgress: z.boolean().optional(),
  seed: z.boolean().optional(),
  delegate: delegateSchema,
});

// Request schemas for each model type (use canonical types since transforms normalize)
// Use base schemas (no defaults) for client-side validation.
// Server applies device defaults, then full schema defaults.
export const loadLlmModelRequestSchema = commonModelConfigSchema
  .extend({
    modelType: z.literal(ModelType.llamacppCompletion),
    modelConfig: llmConfigBaseSchema,
  })
  .strict();

export const loadWhisperModelRequestSchema = commonModelConfigSchema
  .extend({
    modelType: z.literal(ModelType.whispercppTranscription),
    modelConfig: whisperConfigSchema,
  })
  .strict();

export const loadParakeetModelRequestSchema = commonModelConfigSchema
  .extend({
    modelType: z.literal(ModelType.parakeetTranscription),
    modelConfig: parakeetConfigSchema,
  })
  .strict();

export const loadEmbeddingsModelRequestSchema = commonModelConfigSchema
  .extend({
    modelType: z.literal(ModelType.llamacppEmbedding),
    modelConfig: embedConfigBaseSchema,
  })
  .strict();

export const loadNmtModelRequestSchema = commonModelConfigSchema
  .extend({
    modelType: z.literal(ModelType.nmtcppTranslation),
    modelConfig: nmtConfigSchema,
  })
  .strict();

export const loadTtsModelRequestSchema = commonModelConfigSchema
  .extend({
    modelType: z.literal(ModelType.onnxTts),
    modelConfig: ttsConfigSchema,
  })
  .strict();

export const loadOcrModelRequestSchema = commonModelConfigSchema
  .extend({
    modelType: z.literal(ModelType.onnxOcr),
    modelConfig: ocrConfigSchema,
  })
  .strict();

export const loadDiffusionModelRequestSchema = commonModelConfigSchema
  .extend({
    modelType: z.literal(ModelType.sdcppGeneration),
    modelConfig: sdcppConfigSchema.optional(),
  })
  .strict();

// Custom plugin catch-all: accepts any modelType string EXCEPT built-ins
export const loadCustomPluginModelRequestSchema =
  commonModelConfigSchema.extend({
    modelType: z.string().refine((val) => !builtInModelTypes.has(val), {
      message: "Built-in model types must use their specific schema",
    }),
    modelConfig: z.record(z.string(), z.unknown()).optional(),
  });

// Union of all load model request types (using z.union since each modelType accepts multiple values)
export const loadModelSrcRequestSchema = z
  .union([
    loadLlmModelRequestSchema,
    loadWhisperModelRequestSchema,
    loadParakeetModelRequestSchema,
    loadEmbeddingsModelRequestSchema,
    loadNmtModelRequestSchema,
    loadTtsModelRequestSchema,
    loadOcrModelRequestSchema,
    loadDiffusionModelRequestSchema,
    loadCustomPluginModelRequestSchema,
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
  fileSetInfo: z
    .object({
      setKey: z.string(),
      currentFile: z.string(),
      fileIndex: z.number(),
      totalFiles: z.number(),
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

/**
 * Schema for registry:// URLs (internal use only).
 * Users should use model constants from @qvac/sdk instead of raw URLs.
 * Format: registry://source/path/to/model.gguf
 */
export const registryUrlSchema = z
  .string()
  .regex(
    /^registry:\/\/([^/]+)\/(.+)$/,
    "Invalid registry URL. Expected format: registry://source/path/to/model.gguf",
  )
  .transform((url) => {
    const match = url.match(/^registry:\/\/([^/]+)\/(.+)$/)!;
    return {
      registrySource: match[1]!,
      registryPath: match[2]!, // Path without source prefix
    };
  });

const loadModelServerOptionsSchema = commonModelConfigSchema.extend({
  modelType: z.string(),
  modelConfig: z.record(z.string(), z.unknown()).optional(),
});

export const loadModelServerParamsSchema = z.object({
  modelId: z.string(),
  modelPath: z.string(),
  options: loadModelServerOptionsSchema,
  artifacts: z.record(z.string(), z.string()).optional(),
  modelName: z.string().optional(),
});

export type LoadModelServerParams = z.input<typeof loadModelServerParamsSchema>;
export type LoadModelSrcRequest = z.infer<typeof loadModelSrcRequestSchema>;
export type LoadModelRequest = z.infer<typeof loadModelRequestSchema>;
export type LoadModelResponse = z.infer<typeof loadModelResponseSchema>;
export type ModelProgressUpdate = z.infer<typeof modelProgressUpdateSchema>;
/**
 * `loadModel` options for built-in model types.
 * Custom plugin types use {@link LoadCustomPluginModelOptions}.
 */
export type LoadModelOptions = z.input<typeof loadBuiltinModelOptionsBaseSchema> & {
  onProgress?: (progress: ModelProgressUpdate) => void;
  logger?: Logger;
};

/**
 * `loadModel` options for custom plugin model types (any non-built-in string).
 * Built-in model types use {@link LoadModelOptions}.
 */
export type LoadCustomPluginModelOptions<T extends string> = Omit<
  z.input<typeof loadCustomPluginModelOptionsBaseSchema>,
  "modelType"
> & {
  modelType: T extends ModelTypeInput ? never : T;
  onProgress?: (progress: ModelProgressUpdate) => void;
  logger?: Logger;
};

/**
 * `loadModel` options when `modelType` is inferred from `modelSrc`.
 * `modelConfig` is broad; pass a descriptor with a literal `engine` for
 * per-engine narrowing.
 */
export type LoadModelDescriptorOnlyOptions = {
  modelSrc: ModelDescriptor;
  modelType?: never;
  modelConfig?: Record<string, unknown>;
  seed?: boolean;
  delegate?: z.input<typeof delegateSchema>;
  onProgress?: (progress: ModelProgressUpdate) => void;
  logger?: Logger;
};

/**
 * Maps `S["engine"]` (canonical literal) to the matching `modelConfig` input
 * shape. Engines without a known literal fall through to
 * `Record<string, unknown>` (handled by {@link LoadModelDescriptorParam}).
 */
export type InferredConfig<S> = S extends {
  engine: typeof ModelType.llamacppCompletion;
}
  ? z.input<typeof llmConfigBaseSchema>
  : S extends { engine: typeof ModelType.whispercppTranscription }
    ? Partial<z.input<typeof whisperConfigSchema>>
    : S extends { engine: typeof ModelType.llamacppEmbedding }
      ? z.input<typeof embedConfigBaseSchema>
      : S extends { engine: typeof ModelType.nmtcppTranslation }
        ? z.input<typeof nmtConfigSchema>
        : S extends { engine: typeof ModelType.onnxTts }
          ? z.input<typeof ttsConfigSchema>
          : S extends { engine: typeof ModelType.onnxOcr }
            ? Partial<z.input<typeof ocrConfigSchema>>
            : S extends { engine: typeof ModelType.parakeetTranscription }
              ? z.input<typeof parakeetConfigSchema>
              : S extends { engine: typeof ModelType.sdcppGeneration }
                ? z.input<typeof sdcppConfigSchema>
                : Record<string, unknown>;

/**
 * `loadModel` options for descriptors that preserve a literal `engine`.
 * `modelConfig` narrows via {@link InferredConfig}.
 */
export type LoadModelDescriptorInferredOptions<S extends ModelDescriptor> = {
  modelSrc: S;
  modelType?: never;
  modelConfig?: InferredConfig<S>;
  seed?: boolean;
  delegate?: z.input<typeof delegateSchema>;
  onProgress?: (progress: ModelProgressUpdate) => void;
  logger?: Logger;
};

/**
 * Resolves to {@link LoadModelDescriptorInferredOptions} when `S["engine"]` is
 * a known canonical literal, otherwise widens to {@link LoadModelDescriptorOnlyOptions}.
 */
export type LoadModelDescriptorParam<S extends ModelDescriptor> = S extends {
  engine: CanonicalModelType;
}
  ? LoadModelDescriptorInferredOptions<S>
  : Omit<LoadModelDescriptorOnlyOptions, "modelSrc"> & { modelSrc: S };
