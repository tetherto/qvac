import { z } from "zod";

export const parakeetModelTypeEnumSchema = z.enum([
  "tdt",
  "ctc",
  "eou",
  "sortformer",
]);
export type ParakeetModelVariant = z.infer<typeof parakeetModelTypeEnumSchema>;

export const parakeetConfigSchema = z.object({
  modelType: parakeetModelTypeEnumSchema.optional(),
  maxThreads: z.number().int().optional(),
  useGPU: z.boolean().optional(),
  sampleRate: z.number().int().optional(),
  channels: z.number().int().optional(),
  captionEnabled: z.boolean().optional(),
  timestampsEnabled: z.boolean().optional(),
  seed: z.number().int().optional(),
});

export type ParakeetConfig = z.infer<typeof parakeetConfigSchema>;
