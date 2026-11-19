import { z } from 'zod'

const autoOrPositiveInt = z.union([z.literal('auto'), z.number().int().positive()])

const hyperparametersInput = z
  .object({
    n_epochs: autoOrPositiveInt.optional().describe('Passes over the training file.'),
    batch_size: autoOrPositiveInt.optional().describe('Examples per optimizer step.'),
    learning_rate_multiplier: z
      .union([z.literal('auto'), z.number().positive()])
      .optional()
      .describe(
        'Only `"auto"` is accepted: there is no base rate to multiply. Set `qvac.learning_rate` instead.'
      )
  })
  .strict()

export type HyperparametersInput = z.infer<typeof hyperparametersInput>

const qvacOptions = z
  .object({
    learning_rate: z.number().positive().optional().describe('Absolute learning rate.'),
    lora_rank: z.number().int().positive().optional(),
    lora_alpha: z.number().positive().optional(),
    lora_modules: z
      .string()
      .min(1)
      .optional()
      .describe('Comma-separated modules to train, e.g. `attn_q,attn_k,attn_v,attn_o`.'),
    context_length: z.number().int().positive().optional()
  })
  .strict()

export type QvacFineTuningOptions = z.infer<typeof qvacOptions>

export const fineTuningCreateBody = z
  .object({
    model: z
      .string()
      .min(1)
      .optional()
      .describe('Chat model alias declared under `serve.models`. The base the adapter trains on.'),
    training_file: z
      .string()
      .min(1)
      .describe('File id from `POST /v1/files` with `purpose: "fine-tune"`: chat-format JSONL.'),
    validation_file: z
      .string()
      .min(1)
      .nullish()
      .describe('Optional file id, same format as `training_file`.'),
    hyperparameters: hyperparametersInput
      .optional()
      .describe('Legacy location; `method.supervised.hyperparameters` wins when both are set.'),
    method: z
      .object({
        type: z.enum(['supervised', 'dpo', 'reinforcement']),
        supervised: z.object({ hyperparameters: hyperparametersInput.optional() }).optional(),
        dpo: z.unknown().optional(),
        reinforcement: z.unknown().optional()
      })
      .optional()
      .describe('Only `supervised` is supported.'),
    seed: z.number().int().nullish().describe('LoRA initialization seed. Random when omitted.'),
    suffix: z.string().min(1).max(64).nullish(),
    metadata: z.record(z.string().max(64), z.string().max(512)).nullish(),
    integrations: z.array(z.unknown()).nullish().describe('Must be empty.'),
    qvac: qvacOptions.optional().describe('QVAC training knobs the OpenAI shape has no field for.')
  })
  .strict()

export type FineTuningCreateBody = z.infer<typeof fineTuningCreateBody>

export const fineTuningJobIdParam = z.object({ id: z.string().min(1) })

export const fineTuningListQuery = z.object({
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
})

const hyperparameterValue = z.union([z.number(), z.literal('auto')])

const hyperparametersResource = z.object({
  n_epochs: hyperparameterValue,
  batch_size: hyperparameterValue,
  learning_rate_multiplier: hyperparameterValue
})

export const fineTuningJobResource = z.object({
  id: z.string(),
  object: z.literal('fine_tuning.job'),
  model: z.string(),
  created_at: z.number(),
  finished_at: z.number().nullable(),
  fine_tuned_model: z.null(),
  organization_id: z.string(),
  result_files: z.array(z.string()),
  status: z.enum([
    'validating_files',
    'queued',
    'running',
    'paused',
    'succeeded',
    'failed',
    'cancelled'
  ]),
  training_file: z.string(),
  validation_file: z.string().nullable(),
  hyperparameters: hyperparametersResource,
  method: z.object({
    type: z.literal('supervised'),
    supervised: z.object({ hyperparameters: hyperparametersResource })
  }),
  trained_tokens: z.null(),
  error: z
    .object({ code: z.string(), message: z.string(), param: z.string().nullable() })
    .nullable(),
  seed: z.number(),
  estimated_finish: z.number().nullable(),
  integrations: z.array(z.never()),
  metadata: z.record(z.string(), z.string()).nullable(),
  user_provided_suffix: z.string().nullable()
})

export const fineTuningJobList = z.object({
  object: z.literal('list'),
  data: z.array(fineTuningJobResource),
  has_more: z.boolean()
})

export const fineTuningEventList = z.object({
  object: z.literal('list'),
  data: z.array(
    z.object({
      id: z.string(),
      object: z.literal('fine_tuning.job.event'),
      created_at: z.number(),
      level: z.enum(['info', 'warn', 'error']),
      message: z.string(),
      type: z.enum(['message', 'metrics']),
      data: z.record(z.string(), z.number()).optional()
    })
  ),
  has_more: z.boolean()
})

export type ParsedLine = { ok: true } | { ok: false; reason: string }

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool'])

/** Checks one chat-format JSONL line: `{ "messages": [{ "role", "content" }, ...] }`. */
export function checkTrainingLine(line: string): ParsedLine {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'not valid JSON' }
  }
  const messages = (value as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, reason: 'expected a non-empty "messages" array' }
  }
  let sawAssistant = false
  for (const [i, m] of messages.entries()) {
    const role = (m as { role?: unknown } | null)?.role
    const content = (m as { content?: unknown } | null)?.content
    if (typeof role !== 'string' || !ROLES.has(role)) {
      return { ok: false, reason: `messages[${i}].role must be one of ${[...ROLES].join(', ')}` }
    }
    if (typeof content !== 'string') {
      return { ok: false, reason: `messages[${i}].content must be a string` }
    }
    if (role === 'assistant') sawAssistant = true
  }
  if (!sawAssistant) return { ok: false, reason: 'no assistant message to learn from' }
  return { ok: true }
}

/** Returns the first problem in a JSONL dataset, or null when every line passes. */
export function checkTrainingFile(text: string): string | null {
  const lines = text.split('\n')
  let examples = 0
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim()
    if (line.length === 0) continue
    const result = checkTrainingLine(line)
    if (!result.ok) return `line ${i + 1}: ${result.reason}`
    examples++
  }
  return examples === 0 ? 'the file has no examples' : null
}
