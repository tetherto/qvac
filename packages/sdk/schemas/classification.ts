import { z } from "zod";

export const classificationConfigSchema = z.object({
  /** Absolute path to the GGUF weights file. Defaults to the bundled model inside @qvac/classification-ggml. */
  modelPath: z.string().optional(),
  /** Limit returned results to the top-K classes. Default: all classes. */
  topK: z.number().int().optional(),
  /** Forward native C++ log lines through the SDK logger. Off by default. */
  nativeLogger: z.boolean().optional(),
});

export const classifyParamsSchema = z.object({
  modelId: z.string(),
  /** JPEG or PNG buffer encoded as base64, or raw RGB bytes. */
  image: z.string(),
  topK: z.number().int().optional(),
  /** Raw RGB image width (required for raw bytes). */
  width: z.number().int().optional(),
  /** Raw RGB image height (required for raw bytes). */
  height: z.number().int().optional(),
  /** Channel count — must be 3 for raw RGB. */
  channels: z.literal(3).optional(),
});

export const classifyRequestSchema = classifyParamsSchema.extend({
  type: z.literal("classify"),
});

export const classificationResultSchema = z.object({
  label: z.string(),
  confidence: z.number(),
});

export const classifyResponseSchema = z.object({
  type: z.literal("classify"),
  results: z.array(classificationResultSchema),
  done: z.boolean().optional(),
});

export type ClassificationConfig = z.infer<typeof classificationConfigSchema>;
export type ClassifyParams = z.infer<typeof classifyParamsSchema>;
export type ClassifyRequest = z.infer<typeof classifyRequestSchema>;
export type ClassificationResult = z.infer<typeof classificationResultSchema>;
export type ClassifyResponse = z.infer<typeof classifyResponseSchema>;

export interface ClassifyClientParams {
  modelId: string;
  /** JPEG or PNG buffer. */
  image: Uint8Array;
  topK?: number;
  /** Raw RGB image width (required for raw bytes). */
  width?: number;
  /** Raw RGB image height (required for raw bytes). */
  height?: number;
  /** Channel count — must be 3 for raw RGB. */
  channels?: 3;
}
