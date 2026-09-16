import test from 'brittle'
import {
  completionClientParamsSchema,
  completionOrchestrateRequestSchema,
  completionStreamRequestSchema,
  completionStreamResponseSchema,
  completionStatsSchema,
  generationParamsSchema,
  toolDialectSchema
} from '@/schemas/completion-stream'
import { toolSchema } from '@/schemas/tools'
import { REASONING_BUDGET_MAX } from '@/schemas/llamacpp-config'

test("completionStatsSchema: accepts backendDevice 'cpu' and 'gpu'", (t) => {
  t.is(completionStatsSchema.safeParse({ backendDevice: 'cpu' }).success, true)
  t.is(completionStatsSchema.safeParse({ backendDevice: 'gpu' }).success, true)
})

test('completionStatsSchema: rejects unknown backendDevice values', (t) => {
  const result = completionStatsSchema.safeParse({ backendDevice: 'npu' })
  t.is(result.success, false)
})

test('completionStatsSchema: backendDevice is optional', (t) => {
  const result = completionStatsSchema.safeParse({
    timeToFirstToken: 100,
    tokensPerSecond: 50
  })
  t.is(result.success, true)
})

test('generationParamsSchema: accepts reasoning_budget -1 and 0', (t) => {
  t.is(generationParamsSchema.safeParse({ reasoning_budget: -1 }).success, true)
  t.is(generationParamsSchema.safeParse({ reasoning_budget: 0 }).success, true)
})

test('generationParamsSchema: accepts positive reasoning_budget (token cap)', (t) => {
  t.is(generationParamsSchema.safeParse({ reasoning_budget: 1 }).success, true)
  t.is(generationParamsSchema.safeParse({ reasoning_budget: 128 }).success, true)
})

test('generationParamsSchema: rejects reasoning_budget other values', (t) => {
  t.is(generationParamsSchema.safeParse({ reasoning_budget: -2 }).success, false)
  t.is(generationParamsSchema.safeParse({ reasoning_budget: 0.5 }).success, false)
  t.is(
    generationParamsSchema.safeParse({
      reasoning_budget: REASONING_BUDGET_MAX + 1
    }).success,
    false
  )
})

test('generationParamsSchema: accepts remove_thinking_from_context boolean', (t) => {
  t.is(generationParamsSchema.safeParse({ remove_thinking_from_context: true }).success, true)
  t.is(generationParamsSchema.safeParse({ remove_thinking_from_context: false }).success, true)
})

test('generationParamsSchema: rejects non-boolean remove_thinking_from_context', (t) => {
  t.is(generationParamsSchema.safeParse({ remove_thinking_from_context: 1 }).success, false)
})

test('toolDialectSchema: accepts qwen35, gemma4 and dsml', (t) => {
  t.is(toolDialectSchema.safeParse('qwen35').success, true)
  t.is(toolDialectSchema.safeParse('gemma4').success, true)
  t.is(toolDialectSchema.safeParse('dsml').success, true)
})

test('toolDialectSchema: rejects unknown dialects', (t) => {
  t.is(toolDialectSchema.safeParse('unknown').success, false)
})

test('toolSchema: accepts non-string JSON Schema enum values', (t) => {
  const result = toolSchema.safeParse({
    type: 'function',
    name: 'get_sensor_readings_history_by_interval',
    description: 'Retrieve historical sensor readings.',
    parameters: {
      type: 'object',
      properties: {
        interval: {
          type: 'integer',
          description: 'The time interval in seconds for the data returned.',
          enum: [15, 120, 300, 900, 3600, 14400, 86400, 604800]
        },
        includeMeta: {
          type: 'boolean',
          enum: [true, false]
        }
      },
      required: ['interval']
    }
  })

  t.is(result.success, true)
})

test('completionStreamResponseSchema: round-trips backendDevice through completionStats event', (t) => {
  const result = completionStreamResponseSchema.safeParse({
    type: 'completionStream',
    done: true,
    events: [
      {
        type: 'completionStats',
        seq: 0,
        stats: {
          timeToFirstToken: 80,
          tokensPerSecond: 75,
          cacheTokens: 12,
          backendDevice: 'cpu'
        }
      },
      { type: 'completionDone', seq: 1 }
    ]
  })
  t.is(result.success, true)
  if (result.success) {
    const statsEvent = result.data.events.find((e) => e.type === 'completionStats')
    t.ok(statsEvent)
    if (statsEvent && 'stats' in statsEvent) {
      t.is(statsEvent.stats.backendDevice, 'cpu')
    }
  }
})

test('generationParamsSchema: accepts tool_choice modes and a tool name, rejects other shapes', (t) => {
  for (const tool_choice of ['auto', 'none', 'required', 'get_weather']) {
    t.is(generationParamsSchema.safeParse({ tool_choice }).success, true, tool_choice)
  }
  t.is(generationParamsSchema.safeParse({ tool_choice: '' }).success, false, 'empty string')
  t.is(
    generationParamsSchema.safeParse({ tool_choice: { type: 'function' } }).success,
    false,
    'OpenAI object form is mapped by the caller, not accepted here'
  )
})

const weatherTool = {
  type: 'function' as const,
  name: 'get_weather',
  description: 'Get weather for a city',
  parameters: { type: 'object' as const, properties: { city: { type: 'string' as const } } }
}

const baseCompletion = {
  modelId: 'model',
  history: [{ role: 'user', content: 'Weather in Lugano?' }],
  stream: true
}

function acceptsCompletion(params: Record<string, unknown>): boolean {
  return completionClientParamsSchema.safeParse({ ...baseCompletion, ...params }).success
}

test('completionClientParamsSchema: a demanding tool_choice needs matching tools', (t) => {
  t.is(
    acceptsCompletion({ generationParams: { tool_choice: 'required' } }),
    false,
    'required, no tools'
  )
  t.is(
    acceptsCompletion({ generationParams: { tool_choice: 'get_weather' } }),
    false,
    'name, no tools'
  )
  t.is(
    acceptsCompletion({ tools: [weatherTool], generationParams: { tool_choice: 'get_time' } }),
    false,
    'name not among the declared tools'
  )
  t.is(
    acceptsCompletion({ tools: [weatherTool], generationParams: { tool_choice: 'required' } }),
    true
  )
  t.is(
    acceptsCompletion({ tools: [weatherTool], generationParams: { tool_choice: 'get_weather' } }),
    true
  )
})

test('completionClientParamsSchema: auto and none need no tools', (t) => {
  t.is(acceptsCompletion({ generationParams: { tool_choice: 'auto' } }), true)
  t.is(acceptsCompletion({ generationParams: { tool_choice: 'none' } }), true)
})

// The orchestrate request is the entry point for the worker's tool loop, and
// the inner turn it dispatches is never re-parsed -- so an unmatched
// tool_choice has to be rejected here or it reaches the addon.
test('request schemas: every completion entry point rejects an unmatched tool_choice', (t) => {
  const cases = [
    { generationParams: { tool_choice: 'required' } },
    { generationParams: { tool_choice: 'get_weather' } },
    { tools: [weatherTool], generationParams: { tool_choice: 'get_time' } }
  ]
  const accepted = { tools: [weatherTool], generationParams: { tool_choice: 'get_weather' } }

  for (const params of cases) {
    t.is(
      completionStreamRequestSchema.safeParse({
        ...baseCompletion,
        type: 'completionStream',
        ...params
      }).success,
      false,
      `completionStream: ${JSON.stringify(params.generationParams)}`
    )
    t.is(
      completionOrchestrateRequestSchema.safeParse({
        ...baseCompletion,
        type: 'completionOrchestrate',
        ...params
      }).success,
      false,
      `completionOrchestrate: ${JSON.stringify(params.generationParams)}`
    )
  }

  t.is(
    completionStreamRequestSchema.safeParse({
      ...baseCompletion,
      type: 'completionStream',
      ...accepted
    }).success,
    true
  )
  t.is(
    completionOrchestrateRequestSchema.safeParse({
      ...baseCompletion,
      type: 'completionOrchestrate',
      ...accepted
    }).success,
    true
  )
})
