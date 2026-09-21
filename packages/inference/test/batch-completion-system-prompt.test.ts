import test from 'brittle'
import { llmPlugin } from '@/plugins/builtin/llamacpp-completion/plugin'
import {
  clearRegistry,
  registerModel,
  unregisterModel,
  type AnyModel
} from '@/runtime/model-registry'
import { ModelType } from '@/schemas'

// The configured `system_prompt` has to reach the model through the batch
// handler the same way it does through `completion`, or one model and one
// history render two different prompts depending on which handler was called.
//
// Requires the Bare runtime (the plugin pulls in the N-API addon at import).

type LooseHandler = (request: unknown) => AsyncGenerator<unknown, unknown, unknown>

type RecordedPrompt = {
  id?: string
  messages: { role?: string; type?: string; name?: string; content?: string }[]
}

function registerRecordingBatchModel(
  modelId: string,
  prompts: RecordedPrompt[],
  config: Record<string, unknown>
): void {
  registerModel(modelId, {
    model: {
      run(addonPrompts: unknown) {
        const received = addonPrompts as Array<{
          id?: string
          prompt: RecordedPrompt['messages']
        }>
        for (const [index, entry] of received.entries()) {
          prompts.push({ id: entry.id ?? String(index), messages: entry.prompt })
        }
        const ids = received.map((prompt, index) => prompt.id ?? String(index))
        return Promise.resolve({
          ids,
          stats: {},
          iterate: async function* () {
            for (const id of ids) yield { id, chunk: 'ok' }
          },
          await: () =>
            Promise.resolve(ids.map((id) => ({ id, output: 'ok', stopReason: 'stop' as const }))),
          cancel: () => Promise.resolve()
        })
      }
    } as unknown as AnyModel,
    path: `/tmp/${modelId}.gguf`,
    config,
    modelType: ModelType.llamacppCompletion
  })
}

async function runBatch(
  modelId: string,
  history: Array<Array<{ role: string; content: string; attachments: never[] }>>
): Promise<void> {
  const handler = llmPlugin.handlers.batchCompletionStream.handler as unknown as LooseHandler
  const gen = handler({
    modelId,
    requestId: `${modelId}-batch`,
    stream: true,
    prompts: history.map((messages, index) => ({ id: String(index), history: messages }))
  })
  for await (const _ of gen) void _
}

function user(content: string) {
  return { role: 'user', content, attachments: [] as never[] }
}

function system(content: string) {
  return { role: 'system', content, attachments: [] as never[] }
}

test('batchCompletionStream: seeds the configured system prompt per prompt', async (t) => {
  clearRegistry()

  const modelId = `batch-sysprompt-${Date.now()}`
  const prompts: RecordedPrompt[] = []
  registerRecordingBatchModel(modelId, prompts, {
    tools: true,
    system_prompt: 'Always answer with the single word BANANA.'
  })

  await runBatch(modelId, [[user('Capital of France?')], [user('Capital of Spain?')]])

  t.is(prompts.length, 2, 'both prompts reached the model')
  for (const prompt of prompts) {
    const systemMessages = prompt.messages.filter((msg) => msg.role === 'system')
    t.is(systemMessages.length, 1, `prompt ${prompt.id} carries one system message`)
    t.is(
      systemMessages[0]!.content,
      'Always answer with the single word BANANA.',
      `prompt ${prompt.id} carries the configured instruction`
    )
  }

  unregisterModel(modelId)
  clearRegistry()
})

test('batchCompletionStream: keeps a prompt system message over the configured one', async (t) => {
  clearRegistry()

  const modelId = `batch-sysprompt-override-${Date.now()}`
  const prompts: RecordedPrompt[] = []
  registerRecordingBatchModel(modelId, prompts, {
    tools: true,
    system_prompt: 'Always answer with the single word BANANA.'
  })

  await runBatch(modelId, [
    [system('Answer in French.'), user('Capital of France?')],
    [user('Capital of Spain?')]
  ])

  t.alike(
    prompts[0]!.messages.map((msg) => msg.role),
    ['system', 'user'],
    'the prompt that brought its own system message keeps it'
  )
  t.is(
    prompts[0]!.messages.filter((msg) => msg.role === 'system')[0]!.content,
    'Answer in French.',
    'the prompt system message wins'
  )
  t.is(
    prompts[1]!.messages.filter((msg) => msg.role === 'system')[0]!.content,
    'Always answer with the single word BANANA.',
    'the prompt without one is seeded'
  )

  unregisterModel(modelId)
  clearRegistry()
})
