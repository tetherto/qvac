import { z } from "zod";

export const getModelInfoParamsSchema = z.object({
  name: z
    .string()
    .describe(
      "The model's registry name (as found in the SDK's built-in catalog).",
    ),
});

export const getModelInfoRequestSchema = getModelInfoParamsSchema.extend({
  type: z.literal("getModelInfo"),
});

export const loadedInstanceSchema = z.object({
  registryId: z
    .string()
    .describe("Identifier of the registered loaded instance."),
  loadedAt: z
    .coerce.date()
    .describe("Timestamp when the instance was loaded."),
  config: z
    .unknown()
    .optional()
    .describe("Opaque model-specific configuration the instance was loaded with."),
});

export const cacheFileInfoSchema = z.object({
  filename: z.string().describe("Name of the cached file on disk."),
  path: z.string().describe("Absolute path to the cached file."),
  expectedSize: z
    .number()
    .describe("Expected file size in bytes from the model metadata."),
  sha256Checksum: z
    .string()
    .describe("Expected SHA-256 checksum of the file."),
  isCached: z
    .boolean()
    .describe("Whether the file is currently present in the cache."),
  actualSize: z
    .number()
    .optional()
    .describe("Actual size of the cached file on disk, in bytes."),
  cachedAt: z
    .coerce.date()
    .optional()
    .describe("Timestamp when the file was last cached."),
});

export const modelInfoSchema = z.object({
  name: z.string().describe("Catalog name of the model."),
  modelId: z
    .string()
    .describe("Unique identifier used to reference the model in SDK calls."),
  // Registry-based fields
  registryPath: z
    .string()
    .optional()
    .describe("Registry-relative path (set for registry-backed models)."),
  registrySource: z
    .string()
    .optional()
    .describe("Registry source identifier, e.g. `huggingface`."),
  blobCoreKey: z
    .string()
    .optional()
    .describe("Hyperdrive blob core key for the model file."),
  blobBlockOffset: z
    .number()
    .optional()
    .describe("Starting block offset of the model file in the blob."),
  blobBlockLength: z
    .number()
    .optional()
    .describe("Number of blocks occupied by the model file in the blob."),
  blobByteOffset: z
    .number()
    .optional()
    .describe("Starting byte offset of the model file within its block."),
  engine: z
    .string()
    .optional()
    .describe("Inference engine identifier, e.g. `llamacpp-completion`."),
  quantization: z
    .string()
    .optional()
    .describe("Quantization identifier, e.g. `Q4_K_M`."),
  params: z
    .string()
    .optional()
    .describe("Parameter-count label for the model, e.g. `7B`."),
  expectedSize: z
    .number()
    .describe("Expected total size of the model file in bytes."),
  sha256Checksum: z
    .string()
    .describe("Expected SHA-256 checksum of the model file."),
  addon: z
    .enum([
      "llm",
      "whisper",
      "parakeet",
      "embeddings",
      "nmt",
      "vad",
      "tts",
      "ocr",
      "diffusion",
      "other",
    ])
    .describe("Inference addon / capability category this model belongs to."),

  isCached: z
    .boolean()
    .describe("Whether the model file is present in the local cache."),
  isLoaded: z
    .boolean()
    .describe("Whether the model is currently loaded into memory."),
  cacheFiles: z
    .array(cacheFileInfoSchema)
    .describe("Individual cache file entries that make up this model."),

  actualSize: z
    .number()
    .optional()
    .describe("Actual total size of the cached model on disk, in bytes."),
  cachedAt: z
    .coerce.date()
    .optional()
    .describe("Timestamp when the model was last cached."),

  loadedInstances: z
    .array(loadedInstanceSchema)
    .optional()
    .describe("Loaded instances associated with this model (one per live load)."),
});

export const getModelInfoResponseSchema = z.object({
  type: z.literal("getModelInfo"),
  modelInfo: modelInfoSchema,
});

export type GetModelInfoParams = z.input<typeof getModelInfoParamsSchema>;
export type GetModelInfoRequest = z.infer<typeof getModelInfoRequestSchema>;
export type LoadedInstance = z.infer<typeof loadedInstanceSchema>;
export type CacheFileInfo = z.infer<typeof cacheFileInfoSchema>;
export type ModelInfo = z.infer<typeof modelInfoSchema>;
export type GetModelInfoResponse = z.infer<typeof getModelInfoResponseSchema>;
