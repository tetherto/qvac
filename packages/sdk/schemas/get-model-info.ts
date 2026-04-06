import { z } from "zod";

export const getModelInfoParamsSchema = z.object({
  name: z.string(),
});

export const getModelInfoRequestSchema = getModelInfoParamsSchema.extend({
  type: z.literal("getModelInfo"),
});

export const loadedInstanceSchema = z.object({
  registryId: z.string(),
  loadedAt: z.coerce.date(),
  config: z.unknown().optional(),
});

export const cacheFileInfoSchema = z.object({
  filename: z.string(),
  path: z.string(),
  expectedSize: z.number(),
  sha256Checksum: z.string(),
  isCached: z.boolean(),
  actualSize: z.number().optional(),
  cachedAt: z.coerce.date().optional(),
});

export const modelInfoSchema = z.object({
  name: z.string(),
  modelId: z.string(),
  // Registry-based fields
  registryPath: z.string().optional(),
  registrySource: z.string().optional(),
  blobCoreKey: z.string().optional(),
  blobBlockOffset: z.number().optional(),
  blobBlockLength: z.number().optional(),
  blobByteOffset: z.number().optional(),
  engine: z.string().optional(),
  quantization: z.string().optional(),
  params: z.string().optional(),
  expectedSize: z.number(),
  sha256Checksum: z.string(),
  addon: z.enum([
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
  ]),

  isCached: z.boolean(),
  isLoaded: z.boolean(),
  cacheFiles: z.array(cacheFileInfoSchema),

  actualSize: z.number().optional(),
  cachedAt: z.coerce.date().optional(),

  loadedInstances: z.array(loadedInstanceSchema).optional(),
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
