import { z } from "zod";
import {
  completionEventSchema,
  completionStatsSchema,
  type CompletionEvent,
  type CompletionFinal,
  type CompletionStats,
} from "./completion-event";
import {
  completionParamsSchema,
  generationParamsSchema,
  responseFormatSchema,
  toolDialectSchema,
} from "./completion-stream";

export const batchPromptSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional caller-supplied id used to correlate streamed chunks and final results.",
      ),
    history: completionParamsSchema.shape.history,
    generationParams: generationParamsSchema
      .optional()
      .describe("Optional per-prompt sampling / generation parameters."),
    responseFormat: responseFormatSchema
      .optional()
      .describe("Optional per-prompt structured-output constraint."),
  })
  .strict();

const batchCompletionClientParamsBaseSchema = z
  .object({
    modelId: z
      .string()
      .describe("The identifier of the model to use for batch completion."),
    prompts: z
      .array(batchPromptSchema)
      .min(1)
      .refine(
        (prompts) => {
          const ids = prompts
            .map((prompt) => prompt.id)
            .filter((id): id is string => id !== undefined);
          return new Set(ids).size === ids.length;
        },
        {
          // Caller-supplied ids key per-prompt state on the client; dupes
          // would silently merge two prompts' events and results.
          message: "Batch prompt ids must be unique.",
        },
      )
      .describe("Batch prompts submitted to the addon in one run."),
    stream: z
      .boolean()
      .optional()
      .describe(
        "Whether to stream tokens (`true`) or return all events on completion. Defaults to true.",
      ),
    captureThinking: z
      .boolean()
      .optional()
      .describe(
        "When `true`, capture and emit reasoning/thinking deltas separately from content deltas.",
      ),
    emitRawDeltas: z
      .boolean()
      .optional()
      .describe(
        "When `true`, also emit raw per-token deltas in addition to normalized content deltas.",
      ),
    toolDialect: toolDialectSchema
      .optional()
      .describe("Override auto-detected tool-call dialect for all prompts."),
    requestId: z
      .string()
      .min(1)
      .optional()
      .describe("Stable identifier for this in-flight batch request."),
  })
  .strict();

export const batchCompletionClientParamsSchema =
  batchCompletionClientParamsBaseSchema;

export const batchCompletionStreamRequestSchema =
  batchCompletionClientParamsBaseSchema.extend({
    type: z.literal("batchCompletionStream"),
  });

export const batchCompletionEventSchema = z
  .object({
    id: z.string(),
    event: completionEventSchema,
  })
  .strict();

export const batchCompletionStreamResponseSchema = z
  .object({
    type: z.literal("batchCompletionStream"),
    done: z.boolean().optional(),
    ids: z.array(z.string()).optional(),
    events: z.array(batchCompletionEventSchema),
    // Batch-level stats reported once on the terminal (`done`) frame. The
    // addon aggregates decode metrics across the whole batch (e.g.
    // `avgConcurrentSeq`, total prompt/generated tokens) — it does NOT
    // break them down per prompt — so they belong on the run, not on each
    // prompt's `final.stats`.
    stats: completionStatsSchema.optional(),
  })
  .strict();

export type BatchPrompt = z.infer<typeof batchPromptSchema>;
export type BatchCompletionClientParams = z.input<
  typeof batchCompletionClientParamsSchema
>;
export type BatchCompletionStreamRequest = z.infer<
  typeof batchCompletionStreamRequestSchema
>;
export type BatchCompletionEvent = z.infer<typeof batchCompletionEventSchema>;
export type BatchCompletionStreamResponse = z.infer<
  typeof batchCompletionStreamResponseSchema
>;

export type BatchCompletionResult = {
  id: string;
  final: CompletionFinal;
};

export type BatchCompletionRun = {
  requestId: string;
  ids: Promise<string[]>;
  events: AsyncIterable<BatchCompletionEvent>;
  /**
   * Aggregate per-prompt results in prompt order. This promise is
   * **all-or-nothing**: if any single prompt fails (e.g.
   * `ContextOverflowError`) or is cancelled (`InferenceCancelledError`),
   * the whole promise rejects with that first error and the
   * already-completed prompts' results are not surfaced here. Use
   * `byId(id).final` to recover each prompt's outcome independently —
   * successful prompts resolve their `final` even when a sibling fails.
   */
  results: Promise<BatchCompletionResult[]>;
  /**
   * Batch-level decode stats (e.g. `avgConcurrentSeq`, aggregate token
   * counts), reported once for the whole run. The addon does not provide
   * per-prompt stats, so this is the only place batch metrics surface —
   * per-prompt `final.stats` is intentionally left undefined. Resolves to
   * `undefined` when the addon reported no stats.
   */
  stats: Promise<CompletionStats | undefined>;
  byId(id: string): {
    events: AsyncIterable<CompletionEvent>;
    final: Promise<CompletionFinal>;
  };
};
