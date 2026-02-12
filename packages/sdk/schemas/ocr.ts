import { z } from "zod";

// Model config
export const ocrConfigSchema = z.object({
  langList: z.array(z.string()).optional(),
  useGPU: z.boolean().optional(),
  timeout: z.number().optional(),
  magRatio: z.number().optional(),
  defaultRotationAngles: z.array(z.number()).optional(),
  contrastRetry: z.boolean().optional(),
  lowConfidenceThreshold: z.number().optional(),
  recognizerBatchSize: z.number().optional(),
});

// Image input types
export const imageInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("base64"),
    value: z.string(),
  }),
  z.object({
    type: z.literal("filePath"),
    value: z.string(),
  }),
]);

// OCR options
export const ocrOptionsSchema = z.object({
  paragraph: z.boolean().optional(),
});

export const ocrParamsSchema = z.object({
  modelId: z.string(),
  image: imageInputSchema,
  options: ocrOptionsSchema.optional(),
});

export const ocrStreamRequestSchema = ocrParamsSchema.extend({
  type: z.literal("ocrStream"),
});

export const ocrTextBlockSchema = z.object({
  text: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  confidence: z.number().optional(),
});

export const ocrStatsSchema = z.object({
  detectionTime: z.number().optional(),
  recognitionTime: z.number().optional(),
  totalTime: z.number().optional(),
});

export const ocrStreamResponseSchema = z.object({
  type: z.literal("ocrStream"),
  blocks: z.array(ocrTextBlockSchema).optional(),
  done: z.boolean().optional(),
  error: z.string().optional(),
  stats: ocrStatsSchema.optional(),
});

export type OCRConfig = z.infer<typeof ocrConfigSchema>;
export type ImageInput = z.infer<typeof imageInputSchema>;
export type OCROptions = z.infer<typeof ocrOptionsSchema>;
export type OCRParams = z.infer<typeof ocrParamsSchema>;
export type OCRClientParams = {
  modelId: string;
  image: string | Buffer;
  options?: OCROptions;
  stream?: boolean;
};
export type OCRStreamRequest = z.infer<typeof ocrStreamRequestSchema>;
export type OCRStreamResponse = z.infer<typeof ocrStreamResponseSchema>;
export type OCRTextBlock = z.infer<typeof ocrTextBlockSchema>;
export type OCRStats = z.infer<typeof ocrStatsSchema>;
