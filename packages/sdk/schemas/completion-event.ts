import { z } from "zod";
import {
  toolCallSchema,
  toolCallErrorSchema,
  type Tool,
  type ToolCallWithCall,
} from "./tools";

export const completionStatsSchema = z.object({
  timeToFirstToken: z.number().optional(),
  tokensPerSecond: z.number().optional(),
  cacheTokens: z.number().optional(),
  backendDevice: z.enum(["cpu", "gpu"]).optional(),
});

export type CompletionStats = z.infer<typeof completionStatsSchema>;

export const seqSchema = z.number().int().nonnegative();

export const contentDeltaEventSchema = z.object({
  type: z.literal("contentDelta"),
  seq: seqSchema,
  text: z.string(),
});

export const rawDeltaEventSchema = z.object({
  type: z.literal("rawDelta"),
  seq: seqSchema,
  text: z.string(),
});

export const thinkingDeltaEventSchema = z.object({
  type: z.literal("thinkingDelta"),
  seq: seqSchema,
  text: z.string(),
});

export const toolCallEventSchema = z.object({
  type: z.literal("toolCall"),
  seq: seqSchema,
  call: toolCallSchema,
});

export const toolErrorEventSchema = z.object({
  type: z.literal("toolError"),
  seq: seqSchema,
  error: toolCallErrorSchema,
});

export const statsEventSchema = z.object({
  type: z.literal("completionStats"),
  seq: seqSchema,
  stats: completionStatsSchema,
});

export const completionErrorSchema = z.object({
  message: z.string(),
});

const rawOutputSchema = z.object({
  fullText: z.string(),
});

const stopReasonEnum = z.enum(["eos", "length", "stopSequence"]);

const successDoneSchema = z
  .object({
    type: z.literal("completionDone"),
    seq: seqSchema,
    stopReason: stopReasonEnum.optional(),
    raw: rawOutputSchema.optional(),
  })
  .strict();

const errorDoneSchema = z
  .object({
    type: z.literal("completionDone"),
    seq: seqSchema,
    stopReason: z.literal("error"),
    error: completionErrorSchema,
    raw: rawOutputSchema.optional(),
  })
  .strict();

export const doneEventSchema = z.union([errorDoneSchema, successDoneSchema]);

export const completionEventSchema = z.union([
  contentDeltaEventSchema,
  rawDeltaEventSchema,
  thinkingDeltaEventSchema,
  toolCallEventSchema,
  toolErrorEventSchema,
  statsEventSchema,
  errorDoneSchema,
  successDoneSchema,
]);

export type ContentDeltaEvent = z.infer<typeof contentDeltaEventSchema>;
export type RawDeltaEvent = z.infer<typeof rawDeltaEventSchema>;
export type ThinkingDeltaEvent = z.infer<typeof thinkingDeltaEventSchema>;
export type ToolCallEvent = z.infer<typeof toolCallEventSchema>;
export type ToolErrorEvent = z.infer<typeof toolErrorEventSchema>;
export type StatsEvent = z.infer<typeof statsEventSchema>;
export type CompletionError = z.infer<typeof completionErrorSchema>;
export type DoneEvent = z.infer<typeof doneEventSchema>;
export type CompletionEvent = z.infer<typeof completionEventSchema>;
export type StopReason = z.infer<typeof stopReasonEnum>;

export type CompletionFinal = {
  contentText: string;
  thinkingText?: string;
  toolCalls: ToolCallWithCall[];
  stats?: CompletionStats;
  raw: {
    fullText: string;
    toolDialect?: string;
  };
};

export type CompletionRun = {
  /** Ordered stream of typed completion events — the canonical consumption API. */
  events: AsyncIterable<CompletionEvent>;
  /** Resolves when the stream ends with aggregated content, thinking, tool calls, stats, and raw output. */
  final: Promise<CompletionFinal>;

  tokenStream: AsyncGenerator<string>;
  toolCallStream: AsyncGenerator<ToolCallEvent>;
  text: Promise<string>;
  toolCalls: Promise<ToolCallWithCall[]>;
  stats: Promise<CompletionStats | undefined>;
};

export type ToolCallingCapability = "textParse" | "none";
export type ThinkingFramingCapability = "thinkTags" | "none";

export type PluginCapabilities = {
  toolCalling: ToolCallingCapability;
  thinkingFraming: ThinkingFramingCapability;
};

export const DEFAULT_PLUGIN_CAPABILITIES: PluginCapabilities = {
  toolCalling: "none",
  thinkingFraming: "none",
};

export type NormalizerConfig = {
  capabilities: PluginCapabilities;
  tools: Tool[];
  captureThinking: boolean;
  emitRawDeltas: boolean;
};
