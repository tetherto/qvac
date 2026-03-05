import { z } from "zod";
import { modelSrcInputSchema } from "./model-src-utils";

// Only TDT is currently supported
// Other variants (ctc, eou, sortformer) can be added once available upstream.
export const parakeetModelTypeEnumSchema = z.enum(["tdt"]);
export type ParakeetModelVariant = z.infer<typeof parakeetModelTypeEnumSchema>;

export const parakeetRuntimeConfigSchema = z.object({
  modelType: parakeetModelTypeEnumSchema.default("tdt"),
  maxThreads: z.number().int().optional(),
  useGPU: z.boolean().optional(),
  sampleRate: z.number().int().optional(),
  channels: z.number().int().optional(),
  captionEnabled: z.boolean().optional(),
  timestampsEnabled: z.boolean().optional(),
});

export const parakeetConfigSchema = parakeetRuntimeConfigSchema.extend({
  parakeetEncoderDataSrc: modelSrcInputSchema.optional(),
  parakeetDecoderSrc: modelSrcInputSchema,
  parakeetVocabSrc: modelSrcInputSchema,
  parakeetPreprocessorSrc: modelSrcInputSchema,
});

export type ParakeetRuntimeConfig = z.infer<typeof parakeetRuntimeConfigSchema>;
export type ParakeetConfig = z.infer<typeof parakeetConfigSchema>;
