import { z } from "zod";

// QVAC Model Registry entry schema matching the RegistryItem from models/hyperdrive/models.ts
const qvacModelRegistryEntryAddonSchema = z.enum([
  "llm",
  "whisper",
  "embeddings",
  "nmt",
  "vad",
  "tts",
  "ocr",
  "other",
]);

export const qvacModelRegistryEntrySchema = z.object({
  name: z.string(),
  registryPath: z.string(),
  registrySource: z.string(),
  blobCoreKey: z.string(),
  blobBlockOffset: z.number(),
  blobBlockLength: z.number(),
  blobByteOffset: z.number(),
  modelId: z.string(),
  addon: qvacModelRegistryEntryAddonSchema,
  expectedSize: z.number(),
  sha256Checksum: z.string(),
  engine: z.string(),
  quantization: z.string(),
  params: z.string(),
});

export type QvacModelRegistryEntry = z.infer<
  typeof qvacModelRegistryEntrySchema
>;
export type QvacModelRegistryEntryAddon = z.infer<
  typeof qvacModelRegistryEntryAddonSchema
>;

// QVAC Model Registry list request/response
export const qvacModelRegistryListRequestSchema = z.object({
  type: z.literal("qvacModelRegistryList"),
});

export const qvacModelRegistryListResponseSchema = z.object({
  type: z.literal("qvacModelRegistryList"),
  success: z.boolean(),
  models: z.array(qvacModelRegistryEntrySchema).optional(),
  error: z.string().optional(),
});

export type QvacModelRegistryListRequest = z.infer<
  typeof qvacModelRegistryListRequestSchema
>;
export type QvacModelRegistryListResponse = z.infer<
  typeof qvacModelRegistryListResponseSchema
>;

// QVAC Model Registry search request/response
export const qvacModelRegistrySearchRequestSchema = z.object({
  type: z.literal("qvacModelRegistrySearch"),
  filter: z.string().optional(),
  engine: z.string().optional(),
  quantization: z.string().optional(),
  addon: qvacModelRegistryEntryAddonSchema.optional(),
});

export const qvacModelRegistrySearchResponseSchema = z.object({
  type: z.literal("qvacModelRegistrySearch"),
  success: z.boolean(),
  models: z.array(qvacModelRegistryEntrySchema).optional(),
  error: z.string().optional(),
});

export type QvacModelRegistrySearchRequest = z.infer<
  typeof qvacModelRegistrySearchRequestSchema
>;
export type QvacModelRegistrySearchResponse = z.infer<
  typeof qvacModelRegistrySearchResponseSchema
>;

// QVAC Model Registry get model request/response
export const qvacModelRegistryGetModelRequestSchema = z.object({
  type: z.literal("qvacModelRegistryGetModel"),
  registryPath: z.string(),
  registrySource: z.string(),
});

export const qvacModelRegistryGetModelResponseSchema = z.object({
  type: z.literal("qvacModelRegistryGetModel"),
  success: z.boolean(),
  model: qvacModelRegistryEntrySchema.optional(),
  error: z.string().optional(),
});

export type QvacModelRegistryGetModelRequest = z.infer<
  typeof qvacModelRegistryGetModelRequestSchema
>;
export type QvacModelRegistryGetModelResponse = z.infer<
  typeof qvacModelRegistryGetModelResponseSchema
>;

// Combined QVAC Model Registry request union
export const qvacModelRegistryRequestSchema = z.union([
  qvacModelRegistryListRequestSchema,
  qvacModelRegistrySearchRequestSchema,
  qvacModelRegistryGetModelRequestSchema,
]);

// Combined QVAC Model Registry response union
export const qvacModelRegistryResponseSchema = z.discriminatedUnion("type", [
  qvacModelRegistryListResponseSchema,
  qvacModelRegistrySearchResponseSchema,
  qvacModelRegistryGetModelResponseSchema,
]);

export type QvacModelRegistryRequest = z.infer<
  typeof qvacModelRegistryRequestSchema
>;
export type QvacModelRegistryResponse = z.infer<
  typeof qvacModelRegistryResponseSchema
>;
