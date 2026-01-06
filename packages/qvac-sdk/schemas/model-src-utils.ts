import { z } from "zod";

export const MODEL_TYPES = [
  "llm",
  "whisper",
  "embeddings",
  "nmt",
  "tts",
] as const;
export type ModelType = (typeof MODEL_TYPES)[number];

export const modelDescriptorSchema = z.object({
  src: z.string(),
  name: z.string().optional(),
  modelId: z.string().optional(),
  hyperdriveKey: z.string().optional(),
  hyperbeeKey: z.string().optional(),
  expectedSize: z.number().optional(),
  sha256Checksum: z.string().optional(),
  addon: z.enum([...MODEL_TYPES, "vad"]).optional(),
});

export const modelSrcInputSchema = z.union([z.string(), modelDescriptorSchema]);

export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;
export type ModelSrcInput = z.infer<typeof modelSrcInputSchema>;

/**
 * Schema that transforms ModelSrc to its src string
 * Usage: modelSrcToStringSchema.parse(modelSrc)
 */
export const modelInputToSrcSchema = modelSrcInputSchema.transform(
  (modelSrc) => {
    return typeof modelSrc === "string" ? modelSrc : modelSrc.src;
  },
);

/**
 * Schema that transforms ModelSrc to its optional name
 * Usage: modelSrcToNameSchema.parse(modelSrc)
 */
export const modelInputToNameSchema = modelSrcInputSchema.transform(
  (modelSrc) => {
    if (typeof modelSrc === "object" && "name" in modelSrc) {
      return typeof modelSrc.name === "string" ? modelSrc.name : undefined;
    }
    return undefined;
  },
);
