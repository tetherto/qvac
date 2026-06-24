import { z } from "zod";

/**
 * `static` (default) — tools are prepended once after the system message and
 * shared across the chat session.
 * `dynamic` — tools are anchored after the last user message and trimmed
 * from the kv-cache once the tool-call chain resolves, so each user prompt
 * can carry its own tool set without poisoning the cache.
 *
 * Implementation detail: maps to the addon's `tools_compact` boolean. The
 * SDK uses the higher-level `static`/`dynamic` naming so the addon-side
 * mapping can change without breaking the public API.
 */
export const TOOLS_MODE = {
  static: "static",
  dynamic: "dynamic",
} as const;

export type ToolsMode = (typeof TOOLS_MODE)[keyof typeof TOOLS_MODE];

export const toolSchema = z.object({
  type: z.literal("function"),
  name: z.string(),
  description: z.string(),
  parameters: z.object({
    type: z.literal("object"),
    properties: z.record(
      z.string(),
      z.object({
        type: z.enum([
          "string",
          "number",
          "integer",
          "boolean",
          "object",
          "array",
        ]),
        description: z.string().optional(),
        enum: z.array(z.string()).optional(),
      }),
    ),
    required: z.array(z.string()).optional(),
  }),
});

export const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  raw: z.string().optional(),
});

export const toolCallErrorSchema = z.object({
  code: z.enum(["PARSE_ERROR", "VALIDATION_ERROR", "UNKNOWN_TOOL"]),
  message: z.string(),
  raw: z.string().optional(),
});

export const toolCallEventSchema = z.union([
  z.object({
    type: z.literal("toolCall"),
    call: toolCallSchema,
  }),
  z.object({
    type: z.literal("toolCallError"),
    error: toolCallErrorSchema,
  }),
]);

export type Tool = z.infer<typeof toolSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export type ToolCallError = z.infer<typeof toolCallErrorSchema>;
export type ToolCallEvent = z.infer<typeof toolCallEventSchema>;

export type ToolCallWithCall = ToolCall & {
  invoke?: () => Promise<unknown>;
};
