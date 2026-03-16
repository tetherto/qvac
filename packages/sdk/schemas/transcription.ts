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

export const transcribeStreamResponseSchema = z.object({
  type: z.literal("transcribeStream"),
  text: z.string().optional(),
  done: z.boolean().optional(),
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

// Live Transcription Schema (bidirectional: audio stream in, text stream out)
export const transcribeLiveRequestSchema = z.object({
  type: z.literal("transcribeLive"),
  modelId: z.string(),
  prompt: z.string().optional(),
});

export const transcribeLiveResponseSchema = z.object({
  type: z.literal("transcribeLive"),
  text: z.string().optional(),
  done: z.boolean().optional(),
  error: z.string().optional(),
});

export type TranscribeLiveRequest = z.infer<
  typeof transcribeLiveRequestSchema
>;
export type TranscribeLiveResponse = z.infer<
  typeof transcribeLiveResponseSchema
>;

export type TranscribeLiveClientParams = {
  modelId: string;
  prompt?: string;
};

export interface TranscribeLiveSession {
  write(audioChunk: Buffer): void;
  end(): void;
  [Symbol.asyncIterator](): AsyncIterator<string>;
}
