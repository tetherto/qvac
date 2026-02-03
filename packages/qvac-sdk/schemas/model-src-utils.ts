import { z } from "zod";
import { modelTypeInputSchema } from "./model-types";

// Addon field accepts model type inputs plus "vad"
const addonSchema = z.union([modelTypeInputSchema, z.literal("vad")]);

export const modelDescriptorSchema = z.object({
  src: z.string(),
  name: z.string().optional(),
  modelId: z.string().optional(),
  hyperdriveKey: z.string().optional(),
  hyperbeeKey: z.string().optional(),
  expectedSize: z.number().optional(),
  sha256Checksum: z.string().optional(),
  addon: addonSchema.optional(),
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
