import { z } from "zod";
import { toolSchema } from "./tools";
import { completionEventSchema } from "./completion-event";

export {
  completionStatsSchema,
  type CompletionStats,
} from "./completion-event";

/**
 * Tool-call output dialect. Auto-detected from the model name; pass via
 * `completion({ toolDialect })` to override.
 *
 * Expected raw model output per dialect:
 * - `"hermes"`:   `<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>`
 * - `"pythonic"`: `[get_weather(city="Tokyo")]` (optionally `<|tool_call_start|>...<|tool_call_end|>`-wrapped)
 * - `"json"`:     `{"name":"get_weather","arguments":{"city":"Tokyo"}}` or `{"tool_calls":[{"name":"...","arguments":{...}}]}`
 * - `"harmony"`:  `<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>{"city":"Tokyo"}<|call|>`
 * - `"qwen35"`:   `<tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>`
 * - `"gemma4"`:   `<|tool_call>call:NAME{key:<|"|>val<|"|>,...}<tool_call|>`
 */
export const toolDialectSchema = z.enum([
  "hermes",
  "pythonic",
  "json",
  "harmony",
  "qwen35",
  "gemma4"
]);

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
    seed: z.number().optional().describe("Random seed for reproducibility."),
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
    reasoning_budget: z
      .union([z.literal(-1), z.literal(0)])
      .optional()
      .describe(
        "Per-request reasoning channel budget. `-1` keeps the model's reasoning channel on; `0` disables it for this request. Equivalent to the load-time `reasoning_budget` config but scoped to a single `run()` call; the prior value is restored afterwards.",
      ),
    remove_thinking_from_context: z
      .boolean()
      .optional()
      .describe(
        "When the model emits a reasoning block during generation (e.g. `<think>...</think>` for the Qwen3 family, `<|channel>thought ... <channel|>` for Gemma 4), drop those tokens from the KV cache at end-of-generation so subsequent turns do not accumulate reasoning history. Defaults to `false`. No-op for models without a recognised reasoning channel. Throws on models with recurrent memory (SSM / hybrid SSM such as Qwen3.5), where the cache edit is unsupported.",
      ),
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
          name: z
            .string()
            .min(1)
            .describe(
              "Schema identifier; OpenAI-compatibility only — not used by the addon.",
            ),
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
  requestId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Stable identifier for this in-flight request, generated by the client at call time (opaque token, UUIDv4 when available). Surfaced on the `CompletionRun` result so callers can target it with `cancel({ requestId })`. Optional on the wire so legacy clients keep working — the server falls back to a server-generated id when the field is missing. Note: cancel-by-requestId only takes effect once the server has begun the request, so a cancel issued in the same tick as `completion()` may arrive before the request is registered.",
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
