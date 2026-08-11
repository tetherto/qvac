import test from 'brittle'
import { llmPlugin } from '@/server/bare/plugins/llamacpp-completion/plugin'
import {
  clearRegistry,
  registerModel,
  unregisterModel,
  type AnyModel
} from '@/server/bare/registry/model-registry'
import { ModelType } from '@/schemas'

// -----------------------------------------------------------------------------
// Tool definitions must reach the model on every kv-cache path.
//
// The primed prefix is rendered on its own, so it can only contain a message
// list that every chat template accepts. A system message plus tool
// definitions is not such a list: Qwen3.5 raises
// `No user query found in messages.` because its tool block is anchored on the
// last user query, and the addon answers a template failure by re-rendering
// without Jinja — which silently drops the tools. Static mode then never
// resent them, on the assumption they were already cached, so the model
// received no tools at all and answered in prose.
//
// The two assertions below pin the split that avoids it: nothing but the
// system prompt goes into the prefix, and the tools travel with the turn.
//
// Requires the Bare runtime (the plugin pulls in the N-API addon at import).
// -----------------------------------------------------------------------------

type LooseHandler = (request: unknown) => AsyncGenerator<unknown, unknown, unknown>

type RecordedCall = {
  messages: { role?: string; type?: string; name?: string }[]
  prefill: boolean
}

function isToolEntry(entry: { type?: string }): boolean {
  return entry.type === 'function'
}

async function setIsolatedHome(): Promise<void> {
  const fs = await import('bare-fs')
  const os = await import('bare-os')
  const path = await import('bare-path')
  const { default: env } = await import('bare-env')
  env['HOME'] = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-kvcache-tools-'))
}

// The session refuses to continue unless the prime left a non-empty cache
// file behind, so the stand-in addon has to produce one.
async function writeCacheFile(cachePath: string): Promise<void> {
  const fs = await import('bare-fs')
  const path = await import('bare-path')
  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  fs.writeFileSync(cachePath, 'primed')
}

test('completion: kv-cache keeps tools out of the prefix and sends them with the turn', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-tools-model-${Date.now()}`
  const calls: RecordedCall[] = []

  registerModel(modelId, {
    model: {
      run(
        prompt: unknown,
        opts?: { prefill?: boolean; cacheKey?: string; saveCacheToDisk?: boolean }
      ) {
        calls.push({
          messages: prompt as RecordedCall['messages'],
          prefill: opts?.prefill === true
        })
        const written =
          opts?.saveCacheToDisk === true && opts.cacheKey !== undefined
            ? writeCacheFile(opts.cacheKey)
            : Promise.resolve()
        return {
          iterate: async function* () {
            await written
            yield 'The area is 25 square units.'
          },
          await: () => written,
          stats: {}
        }
      }
    } as unknown as AnyModel,
    path: '/tmp/kvcache-tools-model.gguf',
    config: { tools: true },
    modelType: ModelType.llamacppCompletion
  })

  const handler = llmPlugin.handlers.completionStream.handler as unknown as LooseHandler
  const gen = handler({
    modelId,
    requestId: `kvcache-tools-${modelId}`,
    history: [
      {
        role: 'user',
        content: 'Find the area of a triangle with a base of 10 and height of 5.',
        attachments: []
      }
    ],
    stream: true,
    kvCache: 'tools-regression-key',
    tools: [
      {
        type: 'function',
        name: 'calculate_triangle_area',
        description: 'Calculate the area of a triangle given its base and height.',
        parameters: {
          type: 'object',
          properties: {
            base: { type: 'integer', description: 'base' },
            height: { type: 'integer', description: 'height' }
          },
          required: ['base', 'height']
        }
      }
    ]
  })

  for await (const _ of gen) void _

  const primeCalls = calls.filter((call) => call.prefill)
  const turnCalls = calls.filter((call) => !call.prefill)

  t.is(primeCalls.length, 1, 'the prefix was primed once')
  t.absent(
    primeCalls[0]!.messages.some(isToolEntry),
    'the primed prefix carries no tool definitions'
  )
  t.alike(
    primeCalls[0]!.messages.map((msg) => msg.role),
    ['system'],
    'the primed prefix is the system prompt alone'
  )

  t.is(turnCalls.length, 1, 'the turn reached the model once')
  t.alike(
    turnCalls[0]!.messages.filter(isToolEntry).map((msg) => msg.name),
    ['calculate_triangle_area'],
    'the turn carries the tool definition'
  )
  t.ok(
    turnCalls[0]!.messages.some((msg) => msg.role === 'user'),
    'the turn carries the user message the template anchors tools on'
  )

  unregisterModel(modelId)
  clearRegistry()
})
