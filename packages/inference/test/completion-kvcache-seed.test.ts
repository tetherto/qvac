import test from 'brittle'
import {
  InvalidSeedFromParamsError,
  KvCacheSeedSourceNotFoundError,
  KvCacheSeedToolsMismatchError
} from '@/errors/index'
import { llmPlugin } from '@/plugins/builtin/llamacpp-completion/plugin'
import {
  clearRegistry,
  registerModel,
  unregisterModel,
  type AnyModel
} from '@/runtime/model-registry'
import { ModelType } from '@/schemas'

// -----------------------------------------------------------------------------
// `completion({ kvCache, seedFrom })` through the plugin handler, against a
// stand-in addon. Pinned: the parameter rules, that the addon runs the seeded
// chat on a file holding the source's bytes, that the source keeps its bytes,
// and that the tool list a cache was saved with gates the seed.
//
// Requires the Bare runtime (the plugin pulls in the N-API addon at import).
// -----------------------------------------------------------------------------

type LooseHandler = (request: unknown) => AsyncGenerator<unknown, unknown, unknown>

type RecordedCall = {
  cacheKey: string | undefined
  /** Bytes the cache file held when the addon was handed the key. */
  existingBytes: string | undefined
}

type ToolDef = {
  type: string
  name: string
  description: string
  parameters: unknown
}

type HistoryEntry = { role: string; content: string; attachments: never[] }

function makeTool(name: string): ToolDef {
  return {
    type: 'function',
    name,
    description: `Invoke ${name}.`,
    parameters: {
      type: 'object',
      properties: { value: { type: 'integer', description: 'value' } },
      required: ['value']
    }
  }
}

function user(content: string): HistoryEntry {
  return { role: 'user', content, attachments: [] }
}

function assistant(content: string): HistoryEntry {
  return { role: 'assistant', content, attachments: [] }
}

function system(content: string): HistoryEntry {
  return { role: 'system', content, attachments: [] }
}

async function setIsolatedHome(): Promise<void> {
  const fs = await import('bare-fs')
  const os = await import('bare-os')
  const path = await import('bare-path')
  const { default: env } = await import('bare-env')
  env['HOME'] = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-kvcache-seed-handler-'))
}

async function readBytes(filePath: string | undefined): Promise<string | undefined> {
  const fs = await import('bare-fs')
  if (filePath === undefined || !fs.existsSync(filePath)) return undefined
  return fs.readFileSync(filePath, 'utf8')
}

/**
 * Stand-in addon: records the file each run was handed and what it held, and
 * saves `<key>` bytes under the key so every turn leaves a distinct file.
 */
function registerRecordingModel(modelId: string, calls: RecordedCall[]) {
  const held = new Map<string, string>()
  registerModel(modelId, {
    model: {
      async saveCache(cacheKey: string) {
        const bytes = held.get(cacheKey)
        if (bytes === undefined) throw new Error(`nothing cached under ${cacheKey}`)
        const fs = await import('bare-fs')
        const path = await import('bare-path')
        fs.mkdirSync(path.dirname(cacheKey), { recursive: true })
        fs.writeFileSync(cacheKey, bytes)
      },
      discardCache(cacheKey: string) {
        held.delete(cacheKey)
        return Promise.resolve()
      },
      run(_prompt: unknown, opts?: { cacheKey?: string }) {
        const cacheKey = opts?.cacheKey
        const call: RecordedCall = { cacheKey, existingBytes: undefined }
        calls.push(call)
        const ready = readBytes(cacheKey).then((bytes) => {
          call.existingBytes = bytes
          if (cacheKey !== undefined) held.set(cacheKey, `saved-by:${cacheKey}`)
        })
        return {
          iterate: async function* () {
            await ready
            yield 'Four.'
          },
          await: () => ready,
          stats: {}
        }
      }
    } as unknown as AnyModel,
    path: `/tmp/${modelId}.gguf`,
    config: { tools: true },
    modelType: ModelType.llamacppCompletion
  })
}

function completer(modelId: string) {
  const handler = llmPlugin.handlers.completionStream.handler as unknown as LooseHandler
  let request = 0
  return async (
    history: HistoryEntry[],
    options: { kvCache?: string | boolean; seedFrom?: string; tools?: ToolDef[] } = {}
  ): Promise<void> => {
    request += 1
    const gen = handler({
      modelId,
      requestId: `${modelId}-${request}`,
      history,
      stream: true,
      ...options
    })
    for await (const _ of gen) void _
  }
}

// brittle's matcher wants a no-arg constructor; these errors take arguments.
async function rejectsWith(
  t: { ok: (v: unknown, m?: string) => void; fail: (m?: string) => void },
  promise: Promise<unknown>,
  ctor: new (...args: never[]) => Error,
  message: string
): Promise<void> {
  try {
    await promise
    t.fail(`${message}: resolved`)
  } catch (error) {
    t.ok(
      error instanceof ctor,
      `${message}: ${error instanceof Error ? error.name : String(error)}`
    )
  }
}

const SYSTEM = 'You are a helpful assistant.'

test('completion: seedFrom needs a named kvCache key other than itself', async (t) => {
  await setIsolatedHome()
  clearRegistry()
  const modelId = `seed-params-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)
  const complete = completer(modelId)

  for (const options of [
    { seedFrom: 'base' },
    { kvCache: true as const, seedFrom: 'base' },
    { kvCache: false as const, seedFrom: 'base' },
    { kvCache: 'base', seedFrom: 'base' }
  ]) {
    await rejectsWith(
      t,

      complete([user('Hi')], options),
      InvalidSeedFromParamsError,
      `refused: ${JSON.stringify(options)}`
    )
  }
  t.is(calls.length, 0, 'nothing reached the model')

  unregisterModel(modelId)
  clearRegistry()
})

test('completion: a seeded first turn runs on a copy of the source and leaves the source alone', async (t) => {
  await setIsolatedHome()
  clearRegistry()
  const modelId = `seed-copy-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)
  const complete = completer(modelId)

  const baseHistory = [system(SYSTEM), user('What is two plus two?')]
  await complete(baseHistory, { kvCache: 'base' })
  const basePath = calls[0]!.cacheKey!
  t.is(await readBytes(basePath), `saved-by:${basePath}`, 'the base turn saved its file')

  const chatHistory = [...baseHistory, assistant('Four.'), user('And three plus three?')]
  await complete(chatHistory, { kvCache: 'chat-1', seedFrom: 'base' })
  const seeded = calls[1]!
  t.not(seeded.cacheKey, basePath, 'the chat runs under its own file')
  t.is(seeded.existingBytes, `saved-by:${basePath}`, 'the addon found the source bytes under it')
  t.is(
    await readBytes(seeded.cacheKey),
    `saved-by:${seeded.cacheKey!}`,
    'the chat saved its own file'
  )
  t.is(await readBytes(basePath), `saved-by:${basePath}`, 'the source is unchanged')

  await complete([...chatHistory, assistant('Six.'), user('Thanks')], {
    kvCache: 'chat-1',
    seedFrom: 'no-such-base'
  })
  t.is(
    calls[2]!.existingBytes,
    `saved-by:${seeded.cacheKey!}`,
    'a later seedFrom is ignored: the chat continues on its own cache'
  )

  await complete([user('Fresh chat')], { kvCache: 'chat-2' })
  t.is(calls[3]!.existingBytes, undefined, 'a chat without seedFrom starts cold')

  unregisterModel(modelId)
  clearRegistry()
})

test('completion: a seed is refused when the source is missing or saved with other tools', async (t) => {
  await setIsolatedHome()
  clearRegistry()
  const modelId = `seed-refuse-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)
  const complete = completer(modelId)
  const toolA = makeTool('tool_a')
  const toolB = makeTool('tool_b')

  await rejectsWith(
    t,

    complete([user('Hi')], { kvCache: 'chat-1', seedFrom: 'base' }),
    KvCacheSeedSourceNotFoundError,
    'no base yet'
  )

  const baseHistory = [system(SYSTEM), user('Hi')]
  await complete(baseHistory, { kvCache: 'base', tools: [toolA] })
  const chatHistory = [...baseHistory, assistant('Four.'), user('Next')]

  await rejectsWith(
    t,

    complete([system('Another system prompt.'), user('Next')], {
      kvCache: 'chat-1',
      seedFrom: 'base',
      tools: [toolA]
    }),
    KvCacheSeedSourceNotFoundError,
    'another system prompt is another cache'
  )
  await rejectsWith(
    t,

    complete(chatHistory, { kvCache: 'chat-1', seedFrom: 'base', tools: [toolB] }),
    KvCacheSeedToolsMismatchError,
    'a different tool list is refused'
  )
  await rejectsWith(
    t,

    complete(chatHistory, { kvCache: 'chat-1', seedFrom: 'base' }),
    KvCacheSeedToolsMismatchError,
    'no tools against a base saved with tools is refused'
  )
  t.is(calls.length, 1, 'only the base turn reached the model')

  await complete(chatHistory, { kvCache: 'chat-1', seedFrom: 'base', tools: [toolA] })
  t.is(calls.length, 2, 'the same tool list seeds')
  t.is(calls[1]!.existingBytes, `saved-by:${calls[0]!.cacheKey!}`)

  unregisterModel(modelId)
  clearRegistry()
})
