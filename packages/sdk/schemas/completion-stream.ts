import { z } from "zod";
import { toolSchema } from "./tools";
import { completionEventSchema } from "./completion-event";

export { completionStatsSchema, type CompletionStats } from "./completion-event";

/**
 * Tool-call output dialect. Auto-detected from the model name; pass via
 * `completion({ toolDialect })` to override.
 *
 * Expected raw model output per dialect:
 * - `"hermes"`:   `<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>`
 * - `"pythonic"`: `[get_weather(city="Tokyo")]` (optionally `<|tool_call_start|>...<|tool_call_end|>`-wrapped)
 * - `"json"`:     `{"name":"get_weather","arguments":{"city":"Tokyo"}}` or `{"tool_calls":[{"name":"...","arguments":{...}}]}`
 * - `"harmony"`:  `<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>{"city":"Tokyo"}<|call|>`
 */
export const toolDialectSchema = z.enum(["hermes", "pythonic", "json", "harmony"]);

export const attachmentSchema = z.object({
  path: z
    .string()
    .describe(
      "Absolute or SDK-resolvable path to the attachment file (e.g., image for multimodal models).",
    ),
});

const kvCacheSchema = z.union([
  z.boolean(),
  z.string().min(1, "KV cache key cannot be empty string"),
]);

export const generationParamsSchema = z
  .object({
    temp: z
      .number()
      .optional()
      .describe("Sampling temperature (typically 0–2)."),
    top_p: z
      .number()
      .optional()
      .describe("Top-p (nucleus) sampling cutoff (0–1)."),
    top_k: z
      .number()
      .optional()
      .describe("Top-k sampling — keep only the top K tokens."),
    predict: z
      .number()
      .optional()
      .describe(
        "Max tokens to predict. `-1` = until stop token, `-2` = until context filled.",
      ),
    seed: z
      .number()
      .optional()
      .describe("Random seed for reproducibility."),
    frequency_penalty: z
      .number()
      .optional()
      .describe("Penalty applied to tokens based on frequency so far."),
    presence_penalty: z
      .number()
      .optional()
      .describe("Penalty applied to tokens that have already appeared."),
    repeat_penalty: z
      .number()
      .optional()
      .describe("Penalty applied to repeated tokens."),
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
          name: z.string().min(1).describe("Schema identifier; OpenAI-compatibility only — not used by the addon."),
          description: z
            .string()
            .optional()
            .describe(
              "Free-form schema description. Accepted for OpenAI compatibility only — not forwarded to the addon and does not affect generation.",
            ),
          schema: jsonSchemaObjectSchema.describe(
            "JSON Schema the model output must validate against. Forwarded to the addon as-is and converted to GBNF natively by llama.cpp's `json_schema_to_grammar()`.",
          ),
          strict: z
            .boolean()
            .optional()
            .describe(
              "Accepted for OpenAI compatibility but does NOT trigger OpenAI's auto-tightening semantics (implicit `additionalProperties: false`, all properties required). The schema is forwarded to the addon verbatim, so callers wanting strict validation must encode it explicitly in `schema`.",
            ),
        })
        .strict(),
    })
    .strict(),
]);

export const completionParamsSchema = z.object({
  history: z
    .array(
      z.object({
        role: z
          .string()
          .describe(
            'Message role (e.g., `"user"`, `"assistant"`, `"system"`).',
          ),
        content: z.string().describe("Message content."),
        attachments: z
          .array(attachmentSchema)
          .optional()
          .describe("Optional file attachments for multimodal models."),
      }),
    )
    .describe("Array of conversation messages sent to the model."),
  modelId: z
    .string()
    .describe("The identifier of the model to use for completion."),
  kvCache: kvCacheSchema
    .optional()
    .describe(
      "KV cache configuration — `true` to auto-generate a cache key from history, a string to use a custom key, or `false`/`undefined` to disable.",
    ),
});

const completionClientParamsBaseSchema = completionParamsSchema.extend({
  tools: z
    .array(toolSchema)
    .optional()
    .describe(
      "Optional array of tools (full `Tool` objects or Zod-schema `ToolInput` definitions) the model can call.",
    ),
  stream: z
    .boolean()
    .describe(
      "Whether to stream tokens (`true`) or return the complete response once (`false`).",
    ),
  kvCache: kvCacheSchema.optional(),
  generationParams: generationParamsSchema
    .optional()
    .describe("Optional sampling / generation parameters."),
  captureThinking: z
    .boolean()
    .optional()
    .describe(
      "When `true`, capture and emit reasoning/thinking deltas separately from content deltas; requires a model that frames its thinking output.",
    ),
  emitRawDeltas: z
    .boolean()
    .optional()
    .describe(
      "When `true`, also emit raw per-token deltas in the event stream in addition to normalized `contentDelta` events.",
    ),
  toolDialect: toolDialectSchema
    .optional()
    .describe(
      "Override auto-detected tool-call dialect. Use when the SDK's name-based detection picks the wrong parser chain for your model.",
    ),
  responseFormat: responseFormatSchema
    .optional()
    .describe(
      "Optional structured-output constraint: `text` (default, free-form), `json_object` (any valid JSON), or `json_schema` (output conforms to the provided JSON Schema). Mutually exclusive with `tools`.",
    ),
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
export type ToolDialect = z.infer<typeof toolDialectSchema>;
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
