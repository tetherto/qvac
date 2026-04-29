import { z } from "zod";
import { toolSchema } from "./tools";
import { completionEventSchema } from "./completion-event";

export {
  completionStatsSchema,
  type CompletionStats,
} from "./completion-event";

export const attachmentSchema = z.object({
  path: z.string(),
});

const kvCacheSchema = z.union([
  z.boolean(),
  z.string().min(1, "KV cache key cannot be empty string"),
]);

export const generationParamsSchema = z
  .object({
    temp: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().optional(),
    predict: z.number().optional(),
    seed: z.number().optional(),
    frequency_penalty: z.number().optional(),
    presence_penalty: z.number().optional(),
    repeat_penalty: z.number().optional(),
  })
  .strict();

const jsonSchemaObjectSchema = z.record(z.string(), z.unknown());

export const responseFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }).strict(),
  z.object({ type: z.literal("json_object") }).strict(),
  z
    .object({
      type: z.literal("json_schema"),
      json_schema: z
        .object({
          name: z.string().min(1),
          description: z.string().optional(),
          schema: jsonSchemaObjectSchema,
          strict: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const completionParamsSchema = z.object({
  history: z.array(
    z.object({
      role: z.string(),
      content: z.string(),
      attachments: z.array(attachmentSchema).optional(),
    }),
  ),
  modelId: z.string(),
  kvCache: kvCacheSchema.optional(),
});

const completionClientParamsBaseSchema = completionParamsSchema.extend({
  tools: z.array(toolSchema).optional(),
  stream: z.boolean(),
  kvCache: kvCacheSchema.optional(),
  generationParams: generationParamsSchema.optional(),
  captureThinking: z.boolean().optional(),
  emitRawDeltas: z.boolean().optional(),
  responseFormat: responseFormatSchema.optional(),
});

function refineNoToolsWithStructuredOutput(
  data: {
    tools?: { type: "function"; name: string }[] | undefined;
    responseFormat?: z.infer<typeof responseFormatSchema> | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    data.responseFormat &&
    data.responseFormat.type !== "text" &&
    data.tools &&
    data.tools.length > 0
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "responseFormat (json_object/json_schema) cannot be combined with tools; tools already constrain output via their parameter schema.",
      path: ["responseFormat"],
    });
  }
}

export const completionClientParamsSchema =
  completionClientParamsBaseSchema.superRefine(
    refineNoToolsWithStructuredOutput,
  );

export const completionStreamRequestSchema = completionClientParamsBaseSchema
  .extend({
    type: z.literal("completionStream"),
  })
  .superRefine(refineNoToolsWithStructuredOutput);

export const completionStreamResponseSchema = z
  .object({
    type: z.literal("completionStream"),
    done: z.boolean().optional(),
    events: z.array(completionEventSchema),
  })
  .strict();

export type GenerationParams = z.infer<typeof generationParamsSchema>;
export type CompletionParams = z.infer<typeof completionParamsSchema>;
export type ResponseFormat = z.infer<typeof responseFormatSchema>;
export type CompletionClientParams = z.input<
  typeof completionClientParamsSchema
>;
export type CompletionStreamRequest = z.infer<
  typeof completionStreamRequestSchema
>;
export type CompletionStreamResponse = z.infer<
  typeof completionStreamResponseSchema
>;
export type Attachment = z.infer<typeof attachmentSchema>;
