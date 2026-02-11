import { z } from "zod";

// Only TDT is currently supported
// Other variants (ctc, eou, sortformer) can be added once tested upstream
// and their download logic is implemented in http.ts.
export const parakeetModelTypeEnumSchema = z.enum(["tdt"]);
export type ParakeetModelVariant = z.infer<typeof parakeetModelTypeEnumSchema>;

export const parakeetConfigSchema = z.object({
  modelType: parakeetModelTypeEnumSchema.default("tdt"),
  maxThreads: z.number().int().optional(),
  useGPU: z.boolean().optional(),
  sampleRate: z.number().int().optional(),
  channels: z.number().int().optional(),
  captionEnabled: z.boolean().optional(),
  timestampsEnabled: z.boolean().optional(),
  seed: z.number().int().optional(),
});

export type ParakeetConfig = z.infer<typeof parakeetConfigSchema>;
