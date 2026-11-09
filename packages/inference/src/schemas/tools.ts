import { z } from 'zod'

const jsonSchemaEnumValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

const jsonSchemaTypeSchema = z.enum([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null'
])

// Loose so nested keywords (`items`, `properties`, `anyOf`, `$ref`, ...) reach
// the chat template and tool grammar instead of being stripped.
const toolParameterSchema = z.looseObject({
  type: z.union([jsonSchemaTypeSchema, z.array(jsonSchemaTypeSchema)]).optional(),
  description: z.string().optional(),
  enum: z.array(jsonSchemaEnumValueSchema).optional()
})

export const toolSchema = z.object({
  type: z.literal('function'),
  name: z.string(),
  description: z.string(),
  deferLoading: z
    .boolean()
    .optional()
    .describe(
      'Opt out of the initial prompt. A deferred tool is registered but only its name and description reach the model, in the catalog carried by the built-in `tool_search`; its parameter schema is appended to the conversation once the model searches for it. Tools without this field behave as before.'
    ),
  group: z
    .string()
    .optional()
    .describe(
      'Optional heading this tool is listed under in the deferred catalog — a skill or an MCP server name. Ignored for tools that are not deferred.'
    ),
  parameters: z.looseObject({
    type: z.literal('object'),
    properties: z.record(z.string(), toolParameterSchema),
    required: z.array(z.string()).optional()
  })
})

export const DEFAULT_TOOL_SEARCH_LIMIT = 3
export const MAX_TOOL_SEARCH_LIMIT = 8

export const toolSearchOptionsSchema = z
  .object({
    defaultLimit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        `Definitions one \`tool_search\` call loads when the model passes no \`limit\`. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}, or \`maxLimit\` when that is lower.`
      ),
    maxLimit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        `Most definitions one \`tool_search\` call may load, whatever \`limit\` the model asks for. Defaults to ${MAX_TOOL_SEARCH_LIMIT}.`
      )
  })
  .strict()
  .superRefine((options, ctx) => {
    const maxLimit = options.maxLimit ?? MAX_TOOL_SEARCH_LIMIT
    if (options.defaultLimit !== undefined && options.defaultLimit > maxLimit) {
      ctx.addIssue({
        code: 'custom',
        message: `toolSearch.defaultLimit (${options.defaultLimit}) cannot exceed maxLimit (${maxLimit}).`,
        path: ['defaultLimit']
      })
    }
  })
  .describe(
    'Limits on what the built-in `tool_search` loads per call. Only used when a tool sets `deferLoading`. The limits are stated in the `tool_search` definition at the front of the prompt, so set them once per conversation: changing them re-prefills from there.'
  )

export const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  raw: z.string().optional()
})

export const toolCallErrorSchema = z.object({
  code: z.enum(['PARSE_ERROR', 'VALIDATION_ERROR', 'UNKNOWN_TOOL']),
  message: z.string(),
  raw: z.string().optional()
})

export const toolCallEventSchema = z.union([
  z.object({
    type: z.literal('toolCall'),
    call: toolCallSchema
  }),
  z.object({
    type: z.literal('toolCallError'),
    error: toolCallErrorSchema
  })
])

export type Tool = z.infer<typeof toolSchema>
export type ToolSearchOptions = z.input<typeof toolSearchOptionsSchema>
export type ToolCall = z.infer<typeof toolCallSchema>
export type ToolCallError = z.infer<typeof toolCallErrorSchema>
export type ToolCallEvent = z.infer<typeof toolCallEventSchema>

export type ToolCallWithCall = ToolCall & {
  invoke?: () => Promise<unknown>
}
