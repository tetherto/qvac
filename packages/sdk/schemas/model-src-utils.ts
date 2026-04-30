import { z } from "zod";
import {
  modelTypeInputSchema,
  normalizeModelType,
  isCanonicalModelType,
  isModelTypeAlias,
} from "./model-types";
import { resolveCanonicalEngine } from "./engine-addon-map";

// Addon field accepts model type inputs plus "vad"
const addonSchema = z.union([modelTypeInputSchema, z.literal("vad")]);

export const modelDescriptorSchema = z.object({
  src: z.string(),
  name: z.string().optional(),
  modelId: z.string().optional(),
  registryPath: z.string().optional(),
  registrySource: z.string().optional(),
  blobCoreKey: z.string().optional(),
  blobIndex: z.number().optional(),
  engine: z.string().optional(),
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

export function inferModelTypeFromModelSrc(
  modelSrc: unknown,
): string | undefined {
  if (typeof modelSrc !== "object" || modelSrc === null) {
    return undefined;
  }
  const descriptor = modelSrc as Record<string, unknown>;

  const engine = descriptor["engine"];
  if (typeof engine === "string" && engine.length > 0) {
    const canonical = resolveCanonicalEngine(engine);
    if (canonical) return canonical;
    if (isCanonicalModelType(engine) || isModelTypeAlias(engine)) {
      return normalizeModelType(engine);
    }
  }

  const addon = descriptor["addon"];
  if (typeof addon === "string" && addon.length > 0) {
    const canonical = resolveCanonicalEngine(addon);
    if (canonical) return canonical;
    if (isCanonicalModelType(addon) || isModelTypeAlias(addon)) {
      return normalizeModelType(addon);
    }
  }

  return undefined;
}
