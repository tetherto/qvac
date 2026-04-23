import { z } from "zod";
import { ModelType } from "./model-types";

// QVAC Model Registry entry schema matching the RegistryItem from models/registry/models.ts
const modelRegistryEntryAddonSchema = z.enum([
  "llm",
  "whisper",
  "embeddings",
  "nmt",
  "vad",
  "tts",
  "ocr",
  "parakeet",
  "diffusion",
  "other",
]);

// Canonical engine names derived from ModelType (schemas/model-types.ts) plus
// registry-only engines not present in ModelType.
// Values reference ModelType.* directly to avoid string duplication.
// The SDK resolves legacy engine names (e.g. @qvac/* package names) to canonical
// form via schemas/engine-addon-map.ts.
export const modelRegistryEngineSchema = z.enum([
  ModelType.llamacppCompletion,
  ModelType.whispercppTranscription,
  ModelType.llamacppEmbedding,
  ModelType.nmtcppTranslation,
  ModelType.onnxTts,
  ModelType.onnxOcr,
  ModelType.parakeetTranscription,
  ModelType.sdcppGeneration,
  "onnx-vad",
]);

export const modelRegistryEntrySchema = z.object({
  name: z.string().describe("Catalog name of the model entry."),
  registryPath: z
    .string()
    .describe("Registry-relative path to the model."),
  registrySource: z
    .string()
    .describe("Registry source identifier, e.g. `huggingface`."),
  blobCoreKey: z
    .string()
    .describe("Hyperdrive blob core key for the model file."),
  blobBlockOffset: z
    .number()
    .describe("Starting block offset of the model file in the blob."),
  blobBlockLength: z
    .number()
    .describe("Number of blocks occupied by the model file."),
  blobByteOffset: z
    .number()
    .describe("Starting byte offset of the model file within its block."),
  modelId: z
    .string()
    .describe("Unique identifier used to reference the model in SDK calls."),
  addon: modelRegistryEntryAddonSchema.describe(
    "Inference addon / capability category this model belongs to.",
  ),
  expectedSize: z
    .number()
    .describe("Expected total size of the model file in bytes."),
  sha256Checksum: z
    .string()
    .describe("Expected SHA-256 checksum of the model file."),
  engine: modelRegistryEngineSchema.describe(
    "Canonical inference engine identifier.",
  ),
  quantization: z
    .string()
    .describe("Quantization identifier, e.g. `Q4_K_M`."),
  params: z
    .string()
    .describe("Parameter-count label for the model, e.g. `7B`."),
});

export type ModelRegistryEntry = z.infer<typeof modelRegistryEntrySchema>;
export type ModelRegistryEntryAddon = z.infer<
  typeof modelRegistryEntryAddonSchema
>;
export type ModelRegistryEngine = z.infer<typeof modelRegistryEngineSchema>;

// QVAC Model Registry list request/response
export const modelRegistryListRequestSchema = z.object({
  type: z.literal("modelRegistryList"),
});

export const modelRegistryListResponseSchema = z.object({
  type: z.literal("modelRegistryList"),
  success: z.boolean(),
  models: z.array(modelRegistryEntrySchema).optional(),
  error: z.string().optional(),
});

export type ModelRegistryListRequest = z.infer<
  typeof modelRegistryListRequestSchema
>;
export type ModelRegistryListResponse = z.infer<
  typeof modelRegistryListResponseSchema
>;

// QVAC Model Registry search request/response
export const modelRegistrySearchRequestSchema = z.object({
  type: z.literal("modelRegistrySearch"),
  filter: z.string().optional(),
  engine: z.string().optional(),
  quantization: z.string().optional(),
  addon: modelRegistryEntryAddonSchema.optional(),
});

export const modelRegistrySearchResponseSchema = z.object({
  type: z.literal("modelRegistrySearch"),
  success: z.boolean(),
  models: z.array(modelRegistryEntrySchema).optional(),
  error: z.string().optional(),
});

export type ModelRegistrySearchRequest = z.infer<
  typeof modelRegistrySearchRequestSchema
>;
export type ModelRegistrySearchResponse = z.infer<
  typeof modelRegistrySearchResponseSchema
>;

// QVAC Model Registry get model request/response
export const modelRegistryGetModelRequestSchema = z.object({
  type: z.literal("modelRegistryGetModel"),
  registryPath: z.string(),
  registrySource: z.string(),
});

export const modelRegistryGetModelResponseSchema = z.object({
  type: z.literal("modelRegistryGetModel"),
  success: z.boolean(),
  model: modelRegistryEntrySchema.optional(),
  error: z.string().optional(),
});

export type ModelRegistryGetModelRequest = z.infer<
  typeof modelRegistryGetModelRequestSchema
>;
export type ModelRegistryGetModelResponse = z.infer<
  typeof modelRegistryGetModelResponseSchema
>;

// Combined QVAC Model Registry request union
export const modelRegistryRequestSchema = z.union([
  modelRegistryListRequestSchema,
  modelRegistrySearchRequestSchema,
  modelRegistryGetModelRequestSchema,
]);

// Combined QVAC Model Registry response union
export const modelRegistryResponseSchema = z.discriminatedUnion("type", [
  modelRegistryListResponseSchema,
  modelRegistrySearchResponseSchema,
  modelRegistryGetModelResponseSchema,
]);

export type ModelRegistryRequest = z.infer<typeof modelRegistryRequestSchema>;
export type ModelRegistryResponse = z.infer<typeof modelRegistryResponseSchema>;
