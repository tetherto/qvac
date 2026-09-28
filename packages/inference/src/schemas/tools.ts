import { z } from 'zod'

const jsonSchemaEnumValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

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
  parameters: z.object({
    type: z.literal('object'),
    properties: z.record(
      z.string(),
      z.object({
        type: z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array']),
        description: z.string().optional(),
        enum: z.array(jsonSchemaEnumValueSchema).optional()
      })
    ),
    required: z.array(z.string()).optional()
  })
})

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
export type ToolCall = z.infer<typeof toolCallSchema>
export type ToolCallError = z.infer<typeof toolCallErrorSchema>
export type ToolCallEvent = z.infer<typeof toolCallEventSchema>

export type ToolCallWithCall = ToolCall & {
  invoke?: () => Promise<unknown>
}
