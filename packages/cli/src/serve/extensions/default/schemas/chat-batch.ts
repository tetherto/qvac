import { z } from 'zod'
import {
  chatMessage,
  responseFormat,
  toolChoice,
  toolDef
} from '@/serve/extensions/openai/schemas/common'

/** Bounds the work one synchronous request can queue on a model. */
export const MAX_BATCH_PROMPTS = 64

/** One `/v1/chat/completions`-shaped request, minus `model` and streaming. */
export const batchPrompt = z.strictObject({
  id: z.string().min(1).optional(),
  messages: z.array(chatMessage).min(1),
  tools: z.array(toolDef).optional(),
  tool_choice: toolChoice.optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: responseFormat.optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  seed: z.number().int().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  reasoning_budget: z.union([z.boolean(), z.literal(-1), z.literal(0)]).optional()
})

export type BatchPromptBody = z.infer<typeof batchPrompt>

/** Mirrors the SDK's `batchCompletion()` arguments. */
export const chatBatchBody = z.strictObject({
  model: z.string().min(1),
  prompts: z.array(batchPrompt).min(1).max(MAX_BATCH_PROMPTS)
})

const toolCall = z.object({
  id: z.string(),
  type: z.string(),
  function: z.object({ name: z.string(), arguments: z.string() })
})

const batchResultItem = z.object({
  id: z.string(),
  index: z.number().int(),
  message: z.object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    reasoning_content: z.string().optional(),
    tool_calls: z.array(toolCall).optional()
  }),
  finish_reason: z.enum(['stop', 'length', 'tool_calls'])
})

export type BatchResultItem = z.infer<typeof batchResultItem>

// Loose, so a stat the SDK adds later still reaches the client through the
// response serializer.
const batchStats = z.looseObject({
  timeToFirstToken: z.number().optional(),
  tokensPerSecond: z.number().optional(),
  promptTokens: z.number().optional(),
  generatedTokens: z.number().optional(),
  avgConcurrentSeq: z.number().optional()
})

export const chatBatchResult = z.object({
  object: z.literal('chat.batch'),
  model: z.string(),
  results: z.array(batchResultItem),
  stats: batchStats.optional()
})

export const CHAT_BATCH_FIELD_CODES: Record<string, string> = {
  prompts: 'invalid_prompts',
  'prompts:too_big': 'too_many_prompts'
}
