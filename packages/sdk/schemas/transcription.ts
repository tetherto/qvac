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

const transcribeBaseSchema = z.object({
  modelId: z.string(),
  prompt: z.string().optional(),
  metadata: z.boolean().optional(),
});

export const transcribeParamsSchema = transcribeBaseSchema.extend({
  audioChunk: audioInputSchema,
});

export const transcribeStatsSchema = z.object({
  audioDuration: z.number().optional(),
  realTimeFactor: z.number().optional(),
  tokensPerSecond: z.number().optional(),
  totalTokens: z.number().optional(),
  totalSegments: z.number().optional(),
  whisperEncodeTime: z.number().optional(),
  whisperDecodeTime: z.number().optional(),
  encoderTime: z.number().optional(),
  decoderTime: z.number().optional(),
  melSpecTime: z.number().optional(),
});

export const transcribeSegmentSchema = z.object({
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  append: z.boolean(),
  id: z.number(),
});

export const transcribeRequestSchema = transcribeParamsSchema.extend({
  type: z.literal("transcribe"),
});

const transcriptionResultBase = z.object({
  text: z.string().optional(),
  done: z.boolean().optional(),
  stats: transcribeStatsSchema.optional(),
  error: z.string().optional(),
  segment: transcribeSegmentSchema.optional(),
});

export const transcribeResponseSchema = transcriptionResultBase.extend({
  type: z.literal("transcribe"),
});

export type AudioInput = z.infer<typeof audioInputSchema>;
export type TranscribeParams = z.infer<typeof transcribeParamsSchema>;
export type TranscribeSegment = z.infer<typeof transcribeSegmentSchema>;
export type TranscribeClientParams = {
  modelId: string;
  audioChunk: string | Buffer;
  prompt?: string;
  metadata?: boolean;
};
export type TranscribeRequest = z.infer<typeof transcribeRequestSchema>;
export type TranscribeResponse = z.infer<typeof transcribeResponseSchema>;

export const transcribeStreamRequestSchema = transcribeBaseSchema.extend({
  type: z.literal("transcribeStream"),
});

export const transcribeStreamResponseSchema = transcriptionResultBase.extend({
  type: z.literal("transcribeStream"),
});

export type TranscribeStreamRequest = z.infer<
  typeof transcribeStreamRequestSchema
>;
export type TranscribeStreamResponse = z.infer<
  typeof transcribeStreamResponseSchema
>;

export type TranscribeStreamClientParams = {
  modelId: string;
  prompt?: string;
  metadata?: boolean;
};

export interface TranscribeStreamSession {
  write(audioChunk: Buffer): void;
  end(): void;
  destroy(): void;
  [Symbol.asyncIterator](): AsyncIterator<string>;
}

export interface TranscribeStreamMetadataSession {
  write(audioChunk: Buffer): void;
  end(): void;
  destroy(): void;
  [Symbol.asyncIterator](): AsyncIterator<TranscribeSegment>;
}

export type TranscribeStats = z.infer<typeof transcribeStatsSchema>;
