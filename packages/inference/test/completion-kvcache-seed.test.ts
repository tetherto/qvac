import test from 'brittle'
import {
  InvalidSeedFromParamsError,
  KvCacheSeedSharingDisabledError,
  KvCacheSeedSourceNotFoundError
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
// stand-in addon. The engine resolves the named cache's file and hands it to
// the addon as `baseCacheKey`; the addon does the reuse. Pinned: the parameter
// rules, the file the addon is pointed at, the refusals the addon would
// otherwise swallow (a missing source, a model with sharing off), and that the
// source is never written.
//
// Requires the Bare runtime (the plugin pulls in the N-API addon at import).
// -----------------------------------------------------------------------------

type LooseHandler = (request: unknown) => AsyncGenerator<unknown, unknown, unknown>

type RecordedCall = {
  cacheKey: string | undefined
  baseCacheKey: string | undefined
}

type HistoryEntry = { role: string; content: string; attachments: never[] }

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
  env['HOME'] = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-kvcache-seed-'))
}

async function readBytes(filePath: string | undefined): Promise<string | undefined> {
  const fs = await import('bare-fs')
  if (filePath === undefined || !fs.existsSync(filePath)) return undefined
  return fs.readFileSync(filePath, 'utf8')
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

/**
 * Stand-in addon: records the keys each run was handed and saves
 * `saved-by:<key>` under its own key, so every file names its writer.
 */
function registerRecordingModel(
  modelId: string,
  calls: RecordedCall[],
  config: Record<string, unknown> = {}
) {
  const held = new Set<string>()
  registerModel(modelId, {
    model: {
      async saveCache(cacheKey: string) {
        if (!held.has(cacheKey)) throw new Error(`nothing cached under ${cacheKey}`)
        const fs = await import('bare-fs')
        const path = await import('bare-path')
        fs.mkdirSync(path.dirname(cacheKey), { recursive: true })
        fs.writeFileSync(cacheKey, `saved-by:${cacheKey}`)
      },
      discardCache(cacheKey: string) {
        held.delete(cacheKey)
        return Promise.resolve()
      },
      run(_prompt: unknown, opts?: { cacheKey?: string; baseCacheKey?: string }) {
        calls.push({ cacheKey: opts?.cacheKey, baseCacheKey: opts?.baseCacheKey })
        if (opts?.cacheKey !== undefined) held.add(opts.cacheKey)
        return {
          iterate: async function* () {
            yield 'Four.'
          },
          await: () => Promise.resolve(),
          stats: {}
        }
      }
    } as unknown as AnyModel,
    path: `/tmp/${modelId}.gguf`,
    config,
    modelType: ModelType.llamacppCompletion
  })
}

function completer(modelId: string) {
  const handler = llmPlugin.handlers.completionStream.handler as unknown as LooseHandler
  let request = 0
  return async (
    history: HistoryEntry[],
    options: { kvCache?: string | boolean; seedFrom?: string } = {}
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

test('completion: a seeded chat points the addon at the source file and writes only its own', async (t) => {
  await setIsolatedHome()
  clearRegistry()
  const modelId = `seed-base-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls, { cache_share_across_keys: true })
  const complete = completer(modelId)

  const baseHistory = [system(SYSTEM), user('What is two plus two?')]
  await complete(baseHistory, { kvCache: 'base' })
  const basePath = calls[0]!.cacheKey!
  t.is(calls[0]!.baseCacheKey, undefined, 'the base turn names no source')
  t.is(await readBytes(basePath), `saved-by:${basePath}`, 'the base turn saved its file')

  const chatHistory = [...baseHistory, assistant('Four.'), user('And three plus three?')]
  await complete(chatHistory, { kvCache: 'chat-1', seedFrom: 'base' })
  const seeded = calls[1]!
  t.is(seeded.baseCacheKey, basePath, 'the addon is pointed at the base file')
  t.not(seeded.cacheKey, basePath, 'the chat runs under its own file')
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
    calls[2]!.baseCacheKey,
    undefined,
    'a chat that has a cache ignores seedFrom, even a missing one'
  )

  await complete([user('Fresh chat')], { kvCache: 'chat-2' })
  t.is(calls[3]!.baseCacheKey, undefined, 'a chat without seedFrom names no source')

  unregisterModel(modelId)
  clearRegistry()
})

test('completion: a seed is refused when the source is missing or sharing is off', async (t) => {
  await setIsolatedHome()
  clearRegistry()
  const modelId = `seed-refuse-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls, { cache_share_across_keys: true })
  const complete = completer(modelId)

  await rejectsWith(
    t,
    complete([user('Hi')], { kvCache: 'chat-1', seedFrom: 'base' }),
    KvCacheSeedSourceNotFoundError,
    'no base yet'
  )

  const baseHistory = [system(SYSTEM), user('Hi')]
  await complete(baseHistory, { kvCache: 'base' })
  await rejectsWith(
    t,
    complete([system('Another system prompt.'), user('Next')], {
      kvCache: 'chat-1',
      seedFrom: 'base'
    }),
    KvCacheSeedSourceNotFoundError,
    'another system prompt is another cache'
  )
  t.is(calls.length, 1, 'only the base turn reached the model')

  // Sharing is off unless the load opts in, and the addon would skip the base file silently.
  const isolatedConfigs: Array<[string, Record<string, unknown>]> = [
    ['without the option', {}],
    ['with the option false', { cache_share_across_keys: false }]
  ]
  for (const [label, config] of isolatedConfigs) {
    const isolated = `seed-isolated-${label.replace(/ /g, '-')}-${Date.now()}`
    const isolatedCalls: RecordedCall[] = []
    registerRecordingModel(isolated, isolatedCalls, config)
    const completeIsolated = completer(isolated)
    await completeIsolated(baseHistory, { kvCache: 'base' })
    await rejectsWith(
      t,
      completeIsolated([...baseHistory, assistant('Hi.'), user('Next')], {
        kvCache: 'chat-1',
        seedFrom: 'base'
      }),
      KvCacheSeedSharingDisabledError,
      `a model loaded ${label} cannot seed`
    )
    t.is(isolatedCalls.length, 1, `the refused seed never reached the model loaded ${label}`)
    unregisterModel(isolated)
  }

  unregisterModel(modelId)
  clearRegistry()
})
