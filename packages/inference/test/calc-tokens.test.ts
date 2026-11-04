import test from 'brittle'
import { calcTokens } from '@/plugins/builtin/llamacpp-completion/ops/calc-tokens'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { calcTokensRequestSchema, ModelType } from '@/schemas/index'

type TestContext = { teardown(cleanup: () => void): void }

function fixture(t: TestContext, id: string, count: (input: unknown) => Promise<number>) {
  registerModel(id, {
    model: { calcTokens: count } as unknown as AnyModel,
    path: '/tmp/model.gguf',
    config: { system_prompt: 'Configured system prompt', tools: true },
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
  t.absent(calcTokensRequestSchema.safeParse({ type: 'calcTokens', modelId: 'llm' }).success)
  t.absent(
    calcTokensRequestSchema.safeParse({
      type: 'calcTokens',
      modelId: 'llm',
      history: [],
      tools: []
    }).success
  )
})
