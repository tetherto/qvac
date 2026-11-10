import test from 'brittle'
import { calcTokens } from '@/plugins/builtin/llamacpp-completion/ops/calc-tokens'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { calcTokensRequestSchema, ModelType } from '@/schemas/index'

type TestContext = { teardown(cleanup: () => void): void }

function fixture(
  t: TestContext,
  id: string,
  count: (input: unknown) => Promise<number>,
  config: { system_prompt?: string; tools?: boolean } = {
    system_prompt: 'Configured system prompt',
    tools: true
  }
) {
  registerModel(id, {
    model: { calcTokens: count } as unknown as AnyModel,
    path: '/tmp/model.gguf',
    config,
    modelType: ModelType.llamacppCompletion
  })
  t.teardown(() => unregisterModel(id))
}

test('calcTokens counts raw text without adding the configured system prompt', async (t) => {
  let input: unknown
  fixture(t, 'raw-count', async (value) => {
    input = value
    return 3
  })

  t.alike(await calcTokens({ type: 'calcTokens', modelId: 'raw-count', text: 'hello world' }), {
    type: 'calcTokens',
    tokens: 3
  })
  t.alike(input, { text: 'hello world' })
})

test('calcTokens stays stable across concurrent calls', async (t) => {
  let calls = 0
  fixture(t, 'concurrent-count', async () => {
    calls++
    await Promise.resolve()
    return 3
  })

  const responses = await Promise.all(
    Array.from({ length: 25 }, () =>
      calcTokens({ type: 'calcTokens', modelId: 'concurrent-count', text: 'hello world' })
    )
  )

  t.is(calls, 25)
  t.ok(responses.every((response) => response.tokens === 3))
})

test('calcTokens renders configured history, tools and a final text turn', async (t) => {
  let input: unknown
  fixture(t, 'prompt-count', async (value) => {
    input = value
    return 17
  })
  const tool = {
    type: 'function' as const,
    name: 'weather',
    description: 'Get weather',
    parameters: {
      type: 'object' as const,
      properties: { city: { type: 'string' as const } },
      required: ['city']
    }
  }

  const response = await calcTokens({
    type: 'calcTokens',
    modelId: 'prompt-count',
    history: [{ role: 'user', content: 'Earlier question' }],
    tools: [tool],
    text: 'Weather in Paris?'
  })

  t.alike(response, { type: 'calcTokens', tokens: 17 })
  t.alike(input, {
    text: 'Weather in Paris?',
    history: [
      { role: 'system', content: 'Configured system prompt' },
      { role: 'user', content: 'Earlier question' }
    ],
    tools: [tool]
  })
})

test('calcTokens contract requires text or a non-empty history', (t) => {
  t.ok(calcTokensRequestSchema.safeParse({ type: 'calcTokens', modelId: 'llm', text: '' }).success)
  t.ok(
    calcTokensRequestSchema.safeParse({
      type: 'calcTokens',
      modelId: 'llm',
      history: [{ role: 'user', content: 'Hello' }]
    }).success
  )
  const missingPrompt = calcTokensRequestSchema.safeParse({ type: 'calcTokens', modelId: 'llm' })
  t.absent(missingPrompt.success)
  if (!missingPrompt.success) {
    t.ok(missingPrompt.error.message.includes('At least one prompt source is required'))
  }
  t.absent(
    calcTokensRequestSchema.safeParse({
      type: 'calcTokens',
      modelId: 'llm',
      history: [],
      tools: []
    }).success
  )
  t.ok(
    calcTokensRequestSchema.safeParse({
      type: 'calcTokens',
      modelId: 'llm',
      text: 'Hello',
      history: []
    }).success
  )
  t.absent(
    calcTokensRequestSchema.safeParse({
      type: 'calcTokens',
      modelId: 'llm',
      text: 'Hello',
      tool: []
    }).success
  )
  t.absent(
    calcTokensRequestSchema.safeParse({
      type: 'calcTokens',
      modelId: 'llm',
      history: [
        { role: 'user', content: 'Describe this image', attachments: [{ path: '/tmp/image.png' }] }
      ]
    }).success
  )
})

test('calcTokens accepts completion-compatible text histories', (t) => {
  const request = calcTokensRequestSchema.parse({
    type: 'calcTokens',
    modelId: 'llm',
    history: [
      {
        role: 'user',
        content: 'Hello',
        attachments: [],
        name: 'ignored-by-completion'
      }
    ]
  })

  t.alike(request, {
    type: 'calcTokens',
    modelId: 'llm',
    history: [{ role: 'user', content: 'Hello', attachments: [] }]
  })
  t.ok(
    calcTokensRequestSchema.safeParse({
      type: 'calcTokens',
      modelId: 'llm',
      history: [{ role: 'user', content: 'Hello', attachments: undefined }]
    }).success
  )
  t.ok(
    calcTokensRequestSchema.safeParse({
      type: 'calcTokens',
      modelId: 'llm',
      history: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'again' }
          ]
        }
      ]
    }).success
  )

  const withMediaContent = calcTokensRequestSchema.safeParse({
    type: 'calcTokens',
    modelId: 'llm',
    history: [
      {
        role: 'user',
        content: [{ type: 'media', path: '/tmp/image.png' }]
      }
    ]
  })
  t.absent(withMediaContent.success)

  const withAttachment = calcTokensRequestSchema.safeParse({
    type: 'calcTokens',
    modelId: 'llm',
    history: [
      {
        role: 'user',
        content: 'Describe this image',
        attachments: [{ path: '/tmp/image.png' }]
      }
    ]
  })
  t.absent(withAttachment.success)
  if (!withAttachment.success) {
    t.ok(withAttachment.error.message.includes('use completion() for attachments'))
  }

  const textWithAttachment = calcTokensRequestSchema.safeParse({
    type: 'calcTokens',
    modelId: 'llm',
    text: 'What is in this image?',
    history: [
      {
        role: 'user',
        content: 'Describe this image',
        attachments: [{ path: '/tmp/image.png' }]
      }
    ]
  })
  t.absent(textWithAttachment.success)
  if (!textWithAttachment.success) {
    t.ok(textWithAttachment.error.message.includes('use completion() for attachments'))
  }
})

test('calcTokens drops tools without switching raw text to the chat template', async (t) => {
  let input: unknown
  fixture(
    t,
    'tools-disabled',
    async (value) => {
      input = value
      return 4
    },
    { system_prompt: 'Configured system prompt', tools: false }
  )

  await calcTokens({
    type: 'calcTokens',
    modelId: 'tools-disabled',
    text: 'Hello',
    tools: [
      {
        type: 'function',
        name: 'weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: {} }
      }
    ]
  })

  t.alike(input, { text: 'Hello' })
})

test('calcTokens renders tools and the configured system prompt when tools are enabled', async (t) => {
  let input: unknown
  fixture(t, 'tools-enabled', async (value) => {
    input = value
    return 6
  })
  const tool = {
    type: 'function' as const,
    name: 'weather',
    description: 'Get weather',
    parameters: { type: 'object' as const, properties: {} }
  }

  await calcTokens({
    type: 'calcTokens',
    modelId: 'tools-enabled',
    text: 'Hello',
    tools: [tool]
  })

  t.alike(input, {
    text: 'Hello',
    history: [{ role: 'system', content: 'Configured system prompt' }],
    tools: [tool]
  })
})

test('calcTokens renders always-loaded tools and tool_search for deferred tools', async (t) => {
  let input: unknown
  fixture(t, 'deferred-tools', async (value) => {
    input = value
    return 8
  })

  await calcTokens({
    type: 'calcTokens',
    modelId: 'deferred-tools',
    history: [{ role: 'user', content: 'Hello' }],
    tools: [
      {
        type: 'function',
        name: 'weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: {} }
      },
      {
        type: 'function',
        name: 'calendar',
        description: 'Read the calendar',
        parameters: { type: 'object', properties: {} },
        deferLoading: true,
        group: 'calendar'
      }
    ]
  })

  const names = (input as { tools?: { name: string }[] }).tools?.map((tool) => tool.name)
  t.alike(names, ['weather', 'tool_search'])
})

test('calcTokens does not add a configured system prompt when history already has one', async (t) => {
  let input: unknown
  fixture(t, 'existing-system', async (value) => {
    input = value
    return 5
  })

  await calcTokens({
    type: 'calcTokens',
    modelId: 'existing-system',
    history: [
      { role: 'system', content: 'Request system prompt' },
      { role: 'user', content: 'Hello' }
    ]
  })

  t.alike(input, {
    history: [
      { role: 'system', content: 'Request system prompt' },
      { role: 'user', content: 'Hello' }
    ]
  })
})

test('calcTokens accepts text with an empty history and seeds the configured system prompt', async (t) => {
  let input: unknown
  fixture(t, 'empty-history', async (value) => {
    input = value
    return 2
  })

  await calcTokens({
    type: 'calcTokens',
    modelId: 'empty-history',
    text: 'Hello',
    history: []
  })

  t.alike(input, {
    text: 'Hello',
    history: [{ role: 'system', content: 'Configured system prompt' }]
  })
})
