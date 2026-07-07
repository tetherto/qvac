import test from 'brittle'
import {
  batchCompletionClientParamsSchema,
  batchCompletionStreamRequestSchema,
  batchCompletionStreamResponseSchema
} from '@/schemas/batch-completion-stream'
import { requestSchema, responseSchema } from '@/schemas/common'

const prompt = {
  id: 'first',
  history: [{ role: 'user', content: 'Reply with APPLE only.' }],
  generationParams: { temp: 0, seed: 42 },
  responseFormat: { type: 'text' as const }
}

const tool = {
  type: 'function' as const,
  name: 'get_weather',
  description: 'Get weather for a city',
  parameters: {
    type: 'object' as const,
    properties: {
      city: { type: 'string' as const }
    },
    required: ['city']
  }
}

const mcp = {
  client: {
    listTools: async function () {
      return { tools: [] }
    },
    callTool: async function () {
      return {}
    }
  }
}

test('batchCompletionClientParamsSchema: accepts batch prompts', (t) => {
  const result = batchCompletionClientParamsSchema.safeParse({
    modelId: 'llama',
    prompts: [prompt],
    stream: true,
    captureThinking: true
  })
  t.is(result.success, true)
})

test('batchCompletionClientParamsSchema: accepts multimodal attachments', (t) => {
  const result = batchCompletionClientParamsSchema.safeParse({
    modelId: 'vision',
    prompts: [
      {
        id: 'image',
        history: [
          {
            role: 'user',
            content: 'What animal is in this image?',
            attachments: [{ path: '/tmp/elephant.jpg' }]
          }
        ]
      }
    ]
  })
  t.is(result.success, true)
})

test('batchCompletionClientParamsSchema: requires at least one prompt', (t) => {
  const result = batchCompletionClientParamsSchema.safeParse({
    modelId: 'llama',
    prompts: []
  })
  t.is(result.success, false)
})

test('batchCompletionClientParamsSchema: rejects duplicate prompt ids', (t) => {
  const result = batchCompletionClientParamsSchema.safeParse({
    modelId: 'llama',
    prompts: [
      { id: 'dup', history: [{ role: 'user', content: 'a' }] },
      { id: 'dup', history: [{ role: 'user', content: 'b' }] }
    ]
  })
  t.is(result.success, false)
})

test('batchCompletionClientParamsSchema: allows multiple prompts without ids', (t) => {
  const result = batchCompletionClientParamsSchema.safeParse({
    modelId: 'llama',
    prompts: [
      { history: [{ role: 'user', content: 'a' }] },
      { history: [{ role: 'user', content: 'b' }] }
    ]
  })
  t.is(result.success, true)
})

test('batchCompletionClientParamsSchema: accepts per-prompt tools and mcp', (t) => {
  const result = batchCompletionClientParamsSchema.safeParse({
    modelId: 'llama',
    prompts: [
      {
        ...prompt,
        tools: [tool],
        mcp: [mcp]
      }
    ]
  })
  t.is(result.success, true)
})

test('batchCompletionClientParamsSchema: rejects per-prompt tools with structured responseFormat', (t) => {
  const result = batchCompletionClientParamsSchema.safeParse({
    modelId: 'llama',
    prompts: [
      {
        id: 'tool-json',
        history: [{ role: 'user', content: 'Call the weather tool.' }],
        tools: [tool],
        responseFormat: { type: 'json_object' as const }
      }
    ]
  })
  t.is(result.success, false)
})

test('batchCompletionStreamRequestSchema: validates wire request', (t) => {
  const request = {
    type: 'batchCompletionStream',
    modelId: 'llama',
    prompts: [prompt],
    requestId: 'req-1'
  }
  t.is(batchCompletionStreamRequestSchema.safeParse(request).success, true)
  t.is(requestSchema.safeParse(request).success, true)
})

test('batchCompletionStreamRequestSchema: accepts resolved tools and rejects client mcp', (t) => {
  const accepted = {
    type: 'batchCompletionStream',
    modelId: 'llama',
    prompts: [{ ...prompt, tools: [tool] }],
    requestId: 'req-tools'
  }
  const rejected = {
    ...accepted,
    prompts: [{ ...prompt, tools: [tool], mcp: [mcp] }]
  }

  t.is(batchCompletionStreamRequestSchema.safeParse(accepted).success, true)
  t.is(batchCompletionStreamRequestSchema.safeParse(rejected).success, false)
})

test('batchCompletionStreamResponseSchema: validates id-tagged events with batch-level stats', (t) => {
  // Stats are batch-level: they ride the top-level `stats` field on the
  // done frame, NOT a per-id completionStats event.
  const response = {
    type: 'batchCompletionStream',
    ids: ['first'],
    done: true,
    events: [
      {
        id: 'first',
        event: { type: 'contentDelta', seq: 0, text: 'APPLE' }
      },
      {
        id: 'first',
        event: { type: 'completionDone', seq: 1 }
      }
    ],
    stats: { avgConcurrentSeq: 1, generatedTokens: 1 }
  }
  t.is(batchCompletionStreamResponseSchema.safeParse(response).success, true)
  t.is(responseSchema.safeParse(response).success, true)
})

test('batchCompletionStreamResponseSchema: stats is optional', (t) => {
  const response = {
    type: 'batchCompletionStream',
    ids: ['first'],
    done: true,
    events: [{ id: 'first', event: { type: 'completionDone', seq: 0 } }]
  }
  t.is(batchCompletionStreamResponseSchema.safeParse(response).success, true)
})
