import { z } from "zod";

export const audioInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("base64"),
    value: z.string(),
  }),
  z.object({
    type: z.literal("filePath"),
    value: z.string(),
  }),
]);

export const transcribeParamsSchema = z.object({
  modelId: z.string(),
  audioChunk: audioInputSchema,
  prompt: z.string().optional(),
});

// Streaming Transcribe Schema (for real-time audio streaming)
export const transcribeStreamRequestSchema = transcribeParamsSchema.extend({
  type: z.literal("transcribeStream"),
});

export const transcribeStatsSchema = z.object({
  // Common stats
  audioDuration: z.number().optional(),
  realTimeFactor: z.number().optional(),
  tokensPerSecond: z.number().optional(),
  totalTokens: z.number().optional(),
  totalSegments: z.number().optional(),
  // whisper-specific timings
  whisperEncodeTime: z.number().optional(),
  whisperDecodeTime: z.number().optional(),
  // parakeet-specific timings
  encoderTime: z.number().optional(),
  decoderTime: z.number().optional(),
  melSpecTime: z.number().optional(),
});

export const transcribeStreamResponseSchema = z.object({
  type: z.literal("transcribeStream"),
  text: z.string().optional(),
  done: z.boolean().optional(),
  stats: transcribeStatsSchema.optional(),
  error: z.string().optional(),
});

export type AudioInput = z.infer<typeof audioInputSchema>;
export type TranscribeParams = z.infer<typeof transcribeParamsSchema>;
export type TranscribeClientParams = {
  modelId: string;
  audioChunk: string | Buffer;
  prompt?: string;
};
export type TranscribeStreamRequest = z.infer<
  typeof transcribeStreamRequestSchema
>;
export type TranscribeStreamResponse = z.infer<
  typeof transcribeStreamResponseSchema
>;
export type TranscribeStats = z.infer<typeof transcribeStatsSchema>;
