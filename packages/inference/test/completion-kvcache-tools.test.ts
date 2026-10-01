import test from 'brittle'
import { AttachmentNotFoundError } from '@/errors/index'
import { llmPlugin } from '@/plugins/builtin/llamacpp-completion/plugin'
import {
  clearRegistry,
  registerModel,
  unregisterModel,
  type AnyModel
} from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime'
import { ModelType } from '@/schemas'

// -----------------------------------------------------------------------------
// A kv-cache turn sends the same prompt as an uncached one: the full history
// (configured system prompt seeded if missing) and the tool block after the
// system message, every turn. The addon compares that prompt with the tokens
// the cache file holds and decodes only what differs, so the plugin keeps no
// record of what a file covers.
//
// These tests pin that prompt shape and the file lifecycle around it: a named
// key keeps whatever the addon saved once the run returns, an existing file
// survives a run that throws, and a file a failed first turn created is
// removed.
//
// Requires the Bare runtime (the plugin pulls in the N-API addon at import).
// -----------------------------------------------------------------------------

type LooseHandler = (request: unknown) => AsyncGenerator<unknown, unknown, unknown>

type RecordedCall = {
  messages: { role?: string; type?: string; name?: string; content?: string }[]
  prefill: boolean
  toolChoice?: string | undefined
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
      properties: {
        base: { type: 'integer', description: 'base' },
        height: { type: 'integer', description: 'height' }
      },
      required: ['base', 'height']
    }
  }
}

const areaTool = makeTool('calculate_triangle_area')

function isToolEntry(entry: { type?: string }): boolean {
  return entry.type === 'function'
}

function toolNames(call: RecordedCall): (string | undefined)[] {
  return call.messages.filter(isToolEntry).map((msg) => msg.name)
}

// Message order with every tool definition collapsed to `tool`.
function shape(call: RecordedCall): (string | undefined)[] {
  return call.messages.map((msg) => (isToolEntry(msg) ? 'tool' : msg.role))
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
  env['HOME'] = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-kvcache-tools-'))
}

// `commitTurn` keeps a cache only when the file exists, so the stand-in addon
// has to produce one wherever it is told to save.
async function writeCacheFile(cachePath: string): Promise<void> {
  const fs = await import('bare-fs')
  const path = await import('bare-path')
  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  fs.writeFileSync(cachePath, 'kv-cache-bytes')
}

async function holdsCommittedBytes(cachePath: string | undefined): Promise<boolean> {
  const fs = await import('bare-fs')
  return (
    cachePath !== undefined &&
    fs.existsSync(cachePath) &&
    fs.readFileSync(cachePath, 'utf8') === 'kv-cache-bytes'
  )
}

/**
 * Stand-in for the addon that records every payload it is handed and reports
 * a cache file for whatever key it was told to save under.
 */
function registerRecordingModel(
  modelId: string,
  calls: RecordedCall[],
  config: Record<string, unknown> = { tools: true },
  cachePaths?: string[],
  stats: Record<string, unknown> = {}
): void {
  registerModel(modelId, {
    model: {
      run(
        prompt: unknown,
        opts?: {
          prefill?: boolean
          cacheKey?: string
          saveCacheToDisk?: boolean
          generationParams?: { tool_choice?: string }
        }
      ) {
        calls.push({
          messages: prompt as RecordedCall['messages'],
          prefill: opts?.prefill === true,
          toolChoice: opts?.generationParams?.tool_choice
        })
        if (cachePaths && opts?.cacheKey !== undefined) cachePaths.push(opts.cacheKey)
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
          stats
        }
      }
    } as unknown as AnyModel,
    path: `/tmp/${modelId}.gguf`,
    config,
    modelType: ModelType.llamacppCompletion
  })
}

// `kvCache` is a named key, `true` for the auto key, or `undefined` for none.
function completer(modelId: string, kvCache: string | true | undefined) {
  const handler = llmPlugin.handlers.completionStream.handler as unknown as LooseHandler
  let request = 0
  return async (
    history: HistoryEntry[],
    tools?: ToolDef[],
    generationParams?: Record<string, unknown>
  ): Promise<void> => {
    request += 1
    const gen = handler({
      modelId,
      requestId: `${modelId}-${request}`,
      history,
      stream: true,
      ...(kvCache !== undefined ? { kvCache } : {}),
      ...(tools ? { tools } : {}),
      ...(generationParams ? { generationParams } : {})
    })
    for await (const _ of gen) void _
  }
}

test('completion: kv-cache sends the tool block with the turn', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-tools-model-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)

  const complete = completer(modelId, 'tools-regression-key')
  await complete(
    [user('Find the area of a triangle with a base of 10 and height of 5.')],
    [areaTool]
  )

  const prefillCalls = calls.filter((call) => call.prefill)
  const turnCalls = calls.filter((call) => !call.prefill)

  t.is(prefillCalls.length, 0, 'a cold turn makes no prefill-only call of its own')
  t.is(turnCalls.length, 1, 'the turn reached the model once')
  t.alike(shape(turnCalls[0]!), ['tool', 'user'], 'the tool block leads the user turn')
  t.alike(
    toolNames(turnCalls[0]!),
    ['calculate_triangle_area'],
    'the turn carries the tool definition'
  )

  unregisterModel(modelId)
  clearRegistry()
})

// The cache file never decides what is sent: the named key, the auto key and
// no cache at all hand the addon the same payload.
test('completion: kv-cache sends the same prompt as the uncached path', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-tools-same-prompt-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)

  const history = [
    system('Answer in French.'),
    user('Area of a triangle, base 10 height 5?'),
    assistant('25.'),
    user('And base 4 height 3?')
  ]
  await completer(modelId, undefined)(history, [areaTool])
  await completer(modelId, 'tools-same-prompt-key')(history, [areaTool])
  await completer(modelId, true)(history, [areaTool])

  const turnCalls = calls.filter((call) => !call.prefill)
  t.is(turnCalls.length, 3, 'every run reached the model')
  t.alike(
    shape(turnCalls[0]!),
    ['system', 'tool', 'user', 'assistant', 'user'],
    'the uncached run sends the full history with the tool block'
  )
  t.alike(turnCalls[1]!.messages, turnCalls[0]!.messages, 'the named key sends the same prompt')
  t.alike(turnCalls[2]!.messages, turnCalls[0]!.messages, 'the auto key sends the same prompt')

  unregisterModel(modelId)
  clearRegistry()
})

test('completion: kv-cache sends the full history and tool block on every warm turn', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-tools-multiturn-${Date.now()}`
  const calls: RecordedCall[] = []
  const cachePaths: string[] = []
  registerRecordingModel(modelId, calls, { tools: true }, cachePaths)

  const complete = completer(modelId, 'tools-multiturn-key')
  const first = user('Area of a triangle, base 10 height 5?')
  const reply = assistant('The area is 25 square units.')
  const second = user('And with base 4 height 3?')

  await complete([first], [areaTool])
  await complete([first, reply, second], [areaTool])

  const prefillCalls = calls.filter((call) => call.prefill)
  const turnCalls = calls.filter((call) => !call.prefill)

  t.is(prefillCalls.length, 0, 'neither turn makes a prefill-only call')
  t.is(turnCalls.length, 2, 'both turns reached the model')
  t.alike(
    shape(turnCalls[1]!),
    ['tool', 'user', 'assistant', 'user'],
    'the warm turn sends the whole conversation behind the tool block'
  )
  t.alike(
    toolNames(turnCalls[1]!),
    ['calculate_triangle_area'],
    'the warm turn carries exactly one copy of the tool block'
  )
  t.is(new Set(cachePaths).size, 1, 'both turns use the same cache file')
  t.ok(await holdsCommittedBytes(cachePaths.at(-1)), 'the cache file is kept')

  unregisterModel(modelId)
  clearRegistry()
})

test('completion: kv-cache sends the system message on every turn', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-system-every-turn-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)

  const complete = completer(modelId, 'system-every-turn-key')
  const sys = system('Answer in French.')
  const first = user('Capital of France?')
  const reply = assistant('Paris.')
  const second = user('And of Spain?')

  await complete([sys, first])
  await complete([sys, first, reply, second])

  const turnCalls = calls.filter((call) => !call.prefill)
  t.is(turnCalls.length, 2, 'both turns reached the model')
  t.alike(shape(turnCalls[0]!), ['system', 'user'], 'the cold turn carries the system message')
  t.alike(
    shape(turnCalls[1]!),
    ['system', 'user', 'assistant', 'user'],
    'the warm turn carries it again, ahead of the whole conversation'
  )

  unregisterModel(modelId)
  clearRegistry()
})

// The cache path hashes only the system prompt, so a tool set that appears
// late or changes keeps the named key's file and still reaches the model.
test('completion: kv-cache sends a tool set that appears late or changes', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-tools-changing-${Date.now()}`
  const calls: RecordedCall[] = []
  const cachePaths: string[] = []
  registerRecordingModel(modelId, calls, { tools: true }, cachePaths)

  const complete = completer(modelId, 'tools-changing-key')
  const turn1 = [user('Hello, no tools yet.')]
  const turn2 = [...turn1, assistant('Hi.'), user('Area of a triangle, base 10 height 5?')]
  const turn3 = [...turn2, assistant('25.'), user('And its perimeter?')]

  await complete(turn1)
  await complete(turn2, [areaTool])
  await complete(turn3, [areaTool, makeTool('calculate_perimeter')])

  const turnCalls = calls.filter((call) => !call.prefill)
  t.is(turnCalls.length, 3, 'all three turns reached the model')

  t.absent(
    turnCalls[0]!.messages.some(isToolEntry),
    'the tools-free turn carries no tool definitions'
  )
  t.alike(
    toolNames(turnCalls[1]!),
    ['calculate_triangle_area'],
    'a tool set that appears after a tools-free turn reaches the model'
  )
  t.alike(
    toolNames(turnCalls[2]!),
    ['calculate_triangle_area', 'calculate_perimeter'],
    'a changed tool set reaches the model'
  )
  t.is(new Set(cachePaths).size, 1, 'every turn uses the same cache path')

  unregisterModel(modelId)
  clearRegistry()
})

// With no user message, Qwen-family templates can't anchor the tool block and
// the addon renders without it. The block still travels on every turn, so the
// next turn that has a user message gets it.
test('completion: kv-cache sends the tool block on a user-less turn and the next one', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-tools-unrendered-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)

  const complete = completer(modelId, 'tools-unrendered-key')
  const seeded = [system('You are helpful.'), assistant('Shall I continue?')]
  await complete(seeded, [areaTool])
  await complete([...seeded, assistant('Continuing.'), user('Area, base 10 height 5?')], [areaTool])

  const turnCalls = calls.filter((call) => !call.prefill)
  t.is(turnCalls.length, 2, 'both turns reached the model')
  t.alike(shape(turnCalls[0]!), ['system', 'tool', 'assistant'], 'the user-less turn has the block')
  t.alike(
    shape(turnCalls[1]!),
    ['system', 'tool', 'assistant', 'assistant', 'user'],
    'the next turn carries it again'
  )

  unregisterModel(modelId)
  clearRegistry()
})

// `toolDefinitionsDropped` is diagnostic only: whatever the addon reports, the
// next turn carries the block.
test('completion: kv-cache sends the tool block whatever the addon reports dropped', async (t) => {
  for (const dropped of [0, 1]) {
    await setIsolatedHome()
    clearRegistry()

    const modelId = `kvcache-tools-dropped-${dropped}-${Date.now()}`
    const calls: RecordedCall[] = []
    registerRecordingModel(modelId, calls, { tools: true }, undefined, {
      toolDefinitionsDropped: dropped
    })

    const complete = completer(modelId, `tools-dropped-${dropped}-key`)
    const first = user('Area of a triangle, base 10 height 5?')
    await complete([first], [areaTool])
    await complete([first, assistant('25.'), user('And base 4 height 3?')], [areaTool])

    const turnCalls = calls.filter((call) => !call.prefill)
    t.is(turnCalls.length, 2, `both turns reached the model (dropped=${dropped})`)
    t.alike(
      toolNames(turnCalls[1]!),
      ['calculate_triangle_area'],
      `the next turn carries the block (dropped=${dropped})`
    )

    unregisterModel(modelId)
    clearRegistry()
  }
})

// The addon arms the tool-call grammar only for a payload that carries tools;
// a demanding tool_choice gets the block it already has, not a second copy.
test('completion: kv-cache sends one tool block on a turn whose tool_choice demands a call', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-tools-required-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)

  const complete = completer(modelId, 'tools-required-key')
  const first = user('Area of a triangle, base 10 height 5?')
  const reply = assistant('The area is 25 square units.')
  const second = user('And with base 4 height 3?')
  const third = user('Thanks. What about base 6 height 2?')

  await complete([first], [areaTool])
  await complete([first, reply, second], [areaTool], { tool_choice: 'required' })
  await complete([first, reply, second, reply, third], [areaTool])

  const turnCalls = calls.filter((call) => !call.prefill)
  t.is(turnCalls.length, 3, 'all three turns reached the model')
  t.alike(
    toolNames(turnCalls[1]!),
    ['calculate_triangle_area'],
    'the required turn carries the block exactly once'
  )
  t.is(turnCalls[1]!.toolChoice, 'required', 'tool_choice reaches the addon')
  t.alike(
    toolNames(turnCalls[2]!),
    ['calculate_triangle_area'],
    'the following auto turn carries the block too'
  )

  unregisterModel(modelId)
  clearRegistry()
})

// A named tool_choice narrows the grammar, not the prompt: the full block is
// sent on that turn and the next.
test('completion: kv-cache sends the full tool block under a named tool_choice', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-tools-named-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)

  const tools = [areaTool, makeTool('calculate_perimeter')]
  const complete = completer(modelId, 'tools-named-key')
  const first = user('Area of a triangle, base 10 height 5?')
  await complete([first], tools, { tool_choice: 'calculate_triangle_area' })
  await complete([first, assistant('25.'), user('And base 4 height 3?')], tools)

  const turnCalls = calls.filter((call) => !call.prefill)
  const fullBlock = ['calculate_triangle_area', 'calculate_perimeter']
  t.is(turnCalls.length, 2, 'both turns reached the model')
  t.is(turnCalls[0]!.toolChoice, 'calculate_triangle_area', 'the name reaches the addon')
  t.alike(toolNames(turnCalls[0]!), fullBlock, 'the named turn sends every tool')
  t.alike(toolNames(turnCalls[1]!), fullBlock, 'the next turn sends every tool')

  unregisterModel(modelId)
  clearRegistry()
})

// The fake throws on the given non-prefill run, so a refusal between two
// committed turns can be pinned against the cache file.
function registerSecondTurnThrowingModel(
  modelId: string,
  calls: RecordedCall[],
  cachePaths: string[],
  thrown: Error,
  throwOnRun = 2
): void {
  let runCount = 0
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
        if (opts?.cacheKey !== undefined) cachePaths.push(opts.cacheKey)
        if (!opts?.prefill) {
          runCount += 1
          if (runCount === throwOnRun) throw thrown
        }
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
    path: `/tmp/${modelId}.gguf`,
    config: {},
    modelType: ModelType.llamacppCompletion
  })
}

// Turn one commits, turn two fails or stops early, turn three retries the same
// history. Returns turn two's error, whether the committed bytes were still on
// disk before the retry, and the non-prefill calls.
async function runRefusalScenario(
  modelId: string,
  calls: RecordedCall[],
  cachePaths: string[],
  kvCacheKey: string
) {
  const complete = completer(modelId, kvCacheKey)
  const first = user('Area of a triangle, base 10 height 5?')
  await complete([first])
  const grown = [first, assistant('25.'), user('And base 4 height 3?')]
  let refusal: unknown
  try {
    await complete(grown)
  } catch (error) {
    refusal = error
  }
  const fileSurvivedRefusal = await holdsCommittedBytes(cachePaths.at(-1))
  await complete(grown)
  return { refusal, fileSurvivedRefusal, turnCalls: calls.filter((call) => !call.prefill) }
}

// The retry sends the full history either way; it is warm because it lands on
// the same cache file the first turn committed.
function assertRetryReusesCache(
  t: { is: (actual: unknown, expected: unknown, message?: string) => void },
  turnCalls: RecordedCall[],
  cachePaths: string[]
): void {
  t.is(turnCalls.length, 3, 'all three turns reached the model')
  t.is(turnCalls[2]!.messages.length, 3, 'the retry sends the full history')
  t.is(new Set(cachePaths).size, 1, 'the retry uses the committed cache file')
}

// A prefill-guard overflow rejects before any decode or save, so it must not
// destroy the last committed cache.
test('completion: kv-cache survives an overflow rejection between turns', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-overflow-preserves-${Date.now()}`
  const calls: RecordedCall[] = []
  const cachePaths: string[] = []
  registerSecondTurnThrowingModel(
    modelId,
    calls,
    cachePaths,
    // Production shape: the async transport delivers the message alone.
    new Error(
      '[TextLlm] context overflow at batch prefill step: cached tokens 400 plus prompt tokens 200 exceed the max context tokens 512'
    )
  )
  const { refusal, fileSurvivedRefusal, turnCalls } = await runRefusalScenario(
    modelId,
    calls,
    cachePaths,
    'overflow-preserves-key'
  )
  t.ok(fileSurvivedRefusal, 'the committed cache file is still on disk after the refusal')
  t.ok(refusal instanceof Error && refusal.name === 'CONTEXT_OVERFLOW', 'turn two is refused')
  assertRetryReusesCache(t, turnCalls, cachePaths)

  unregisterModel(modelId)
  clearRegistry()
})

// The generationParams apply step rejects before touching live state
// (reachable at parallel = 1) and must not destroy the committed cache.
test('completion: kv-cache survives a generationParams rejection between turns', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-genparams-preserves-${Date.now()}`
  const calls: RecordedCall[] = []
  const cachePaths: string[] = []
  registerSecondTurnThrowingModel(
    modelId,
    calls,
    cachePaths,
    new Error('invalid generationParams.json_schema: [json.exception.parse_error.101] parse error')
  )
  const { refusal, fileSurvivedRefusal, turnCalls } = await runRefusalScenario(
    modelId,
    calls,
    cachePaths,
    'genparams-preserves-key'
  )
  t.ok(fileSurvivedRefusal, 'the committed cache file is still on disk after the refusal')
  t.ok(refusal instanceof Error && /json_schema/.test(refusal.message), 'turn two is refused')
  assertRetryReusesCache(t, turnCalls, cachePaths)

  unregisterModel(modelId)
  clearRegistry()
})

// The scheduler's per-sequence-cap admission refusals (parallel >= 2) are
// equally pre-mutation and must not destroy the committed cache either.
test('completion: kv-cache survives a scheduler admission rejection between turns', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-admission-preserves-${Date.now()}`
  const calls: RecordedCall[] = []
  const cachePaths: string[] = []
  registerSecondTurnThrowingModel(
    modelId,
    calls,
    cachePaths,
    new Error(
      'ContinuousBatchScheduler::submit: n_predict 480 + prompt 300 KV cells exceeds per-sequence cap 512 (ctxTotalTokens / n_parallel)'
    )
  )
  const { refusal, fileSurvivedRefusal, turnCalls } = await runRefusalScenario(
    modelId,
    calls,
    cachePaths,
    'admission-preserves-key'
  )
  t.ok(fileSurvivedRefusal, 'the committed cache file is still on disk after the refusal')
  // Scheduler capacity refusals are the batch-mode overflow: the consumer
  // gets the typed error with the reservation-plus-prompt total.
  t.ok(refusal instanceof Error && refusal.name === 'CONTEXT_OVERFLOW', 'turn two is refused typed')
  const typed = refusal as { requiredTokens?: number; ctxSize?: number }
  t.is(typed.requiredTokens, 780, 'the total is the reservation plus the prompt')
  t.is(typed.ctxSize, 512, 'the cap is the effective per-request ceiling')
  assertRetryReusesCache(t, turnCalls, cachePaths)

  unregisterModel(modelId)
  clearRegistry()
})

// The addon's media-load failures reject before any decode or save — like the
// SDK-side missing attachment, they must not destroy the committed cache.
test('completion: kv-cache survives an addon media-load failure between turns', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-media-preserves-${Date.now()}`
  const calls: RecordedCall[] = []
  const cachePaths: string[] = []
  registerSecondTurnThrowingModel(
    modelId,
    calls,
    cachePaths,
    new Error('[MtmdLlm] Failed to load media from file: /tmp/attachment.png\n')
  )
  const { refusal, fileSurvivedRefusal, turnCalls } = await runRefusalScenario(
    modelId,
    calls,
    cachePaths,
    'media-preserves-key'
  )
  t.ok(fileSurvivedRefusal, 'the committed cache file is still on disk after the refusal')
  t.ok(
    refusal instanceof Error && /Failed to load media/.test(refusal.message),
    'turn two fails with the media error'
  )
  assertRetryReusesCache(t, turnCalls, cachePaths)

  unregisterModel(modelId)
  clearRegistry()
})

// A refusal on the FIRST turn has no committed cache to keep — the file this
// turn created is removed and the retry starts cold again.
test('completion: kv-cache drops the cache it created when the first turn is refused', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-cold-refusal-${Date.now()}`
  const calls: RecordedCall[] = []
  const cachePaths: string[] = []
  registerSecondTurnThrowingModel(
    modelId,
    calls,
    cachePaths,
    new Error(
      '[TextLlm] context overflow at batch prefill step: cached tokens 0 plus prompt tokens 600 exceed the max context tokens 512'
    ),
    1
  )
  const complete = completer(modelId, 'cold-refusal-key')
  const first = user('Area of a triangle, base 10 height 5?')
  let refusal: unknown
  try {
    await complete([first])
  } catch (error) {
    refusal = error
  }
  const fs = await import('bare-fs')
  t.ok(refusal instanceof Error && refusal.name === 'CONTEXT_OVERFLOW', 'the first turn is refused')
  t.ok(
    cachePaths.length > 0 && !fs.existsSync(cachePaths[cachePaths.length - 1]!),
    'the cache the refused turn created is not left behind'
  )

  await complete([first])
  t.is(calls.filter((call) => call.prefill).length, 0, 'no prefill-only call on either attempt')
  t.is(calls.filter((call) => !call.prefill).length, 2, 'the retry turn reaches the model')

  unregisterModel(modelId)
  clearRegistry()
})

test('completion: kv-cache survives an unrecognised addon failure between turns', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-unknown-survives-${Date.now()}`
  const calls: RecordedCall[] = []
  const cachePaths: string[] = []
  registerSecondTurnThrowingModel(
    modelId,
    calls,
    cachePaths,
    new Error('addon exploded mid-decode')
  )
  const { refusal, fileSurvivedRefusal, turnCalls } = await runRefusalScenario(
    modelId,
    calls,
    cachePaths,
    'unknown-survives-key'
  )
  t.ok(fileSurvivedRefusal, 'the committed cache file is still on disk after the failure')
  t.ok(refusal instanceof Error && /exploded mid-decode/.test(refusal.message), 'turn two fails')
  assertRetryReusesCache(t, turnCalls, cachePaths)

  unregisterModel(modelId)
  clearRegistry()
})

// Scripted fake: on `cancelOnRun` the run cancels its own request after the
// first token, the way a stop button lands mid-decode. `statsOnRun` is what
// the addon reports for the run; by default a cancelled run reports the
// `none` stop reason and any other run `eos`. `statsThrowOnRun` makes reading
// `stats` throw, an engine-side failure that lands after the addon saved.
function registerScriptedModel(
  modelId: string,
  calls: RecordedCall[],
  cachePaths: string[],
  script: {
    cancelOnRun?: number
    tokensOnRun?: (run: number) => string[]
    statsOnRun?: (run: number) => Record<string, unknown>
    statsThrowOnRun?: number
    config?: Record<string, unknown>
  }
): void {
  const registry = getRequestRegistry()
  let runCount = 0
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
        if (opts?.cacheKey !== undefined) cachePaths.push(opts.cacheKey)
        const run = opts?.prefill ? 0 : ++runCount
        const written =
          opts?.saveCacheToDisk === true && opts.cacheKey !== undefined
            ? writeCacheFile(opts.cacheKey)
            : Promise.resolve()
        const tokens = script.tokensOnRun?.(run) ?? ['The area is 25 square units.']
        const stats = script.statsOnRun?.(run) ?? {
          stopReason: run === script.cancelOnRun ? 'none' : 'eos'
        }
        return {
          iterate: async function* () {
            await written
            for (const token of tokens) yield token
            if (run === script.cancelOnRun) {
              registry.cancel({ requestId: `${modelId}-${run}` })
              await new Promise<void>((resolve) => setTimeout(resolve, 0))
            }
          },
          await: () => written,
          cancel: () => Promise.resolve(),
          get stats() {
            if (run === script.statsThrowOnRun) throw new Error('stats exploded after the save')
            return stats
          }
        }
      },
      addon: { cancel: () => Promise.resolve() }
    } as unknown as AnyModel,
    path: `/tmp/${modelId}.gguf`,
    config: script.config ?? {},
    modelType: ModelType.llamacppCompletion
  })
}

// Once the run returns, the file holds whatever the addon kept — it commits
// or rewinds the request itself — so a named key keeps it whatever the stop.
const keptAfterStop: {
  name: string
  script: Parameters<typeof registerScriptedModel>[3]
}[] = [
  { name: 'a warm turn is cancelled', script: { cancelOnRun: 2 } },
  {
    name: 'an abort lands after generation finished',
    script: { cancelOnRun: 2, statsOnRun: () => ({ stopReason: 'eos' }) }
  },
  {
    name: 'an aborted run reports no stop reason',
    script: { cancelOnRun: 2, statsOnRun: (run) => (run === 2 ? {} : { stopReason: 'eos' }) }
  },
  {
    name: 'a warm turn produces zero tokens',
    script: {
      tokensOnRun: (run) => (run === 2 ? [] : ['25.']),
      statsOnRun: () => ({ stopReason: 'eos' })
    }
  },
  {
    name: 'a warm turn is budget-stopped',
    script: {
      config: { predict: 2 },
      statsOnRun: (run) =>
        run === 2 ? { generatedTokens: 2, stopReason: 'predictionLimit' } : { stopReason: 'eos' }
    }
  },
  {
    name: 'a warm turn stops at the context boundary',
    script: { statsOnRun: (run) => ({ stopReason: run === 2 ? 'contextOverflow' : 'eos' }) }
  }
]

for (const [index, scenario] of keptAfterStop.entries()) {
  test(`completion: kv-cache keeps the file when ${scenario.name}`, async (t) => {
    await setIsolatedHome()
    clearRegistry()

    const modelId = `kvcache-kept-after-stop-${index}-${Date.now()}`
    const calls: RecordedCall[] = []
    const cachePaths: string[] = []
    registerScriptedModel(modelId, calls, cachePaths, scenario.script)
    const { refusal, fileSurvivedRefusal, turnCalls } = await runRefusalScenario(
      modelId,
      calls,
      cachePaths,
      `kept-after-stop-${index}-key`
    )
    t.is(refusal, undefined, 'turn two returns rather than throws')
    t.ok(fileSurvivedRefusal, 'the cache file is still on disk')
    assertRetryReusesCache(t, turnCalls, cachePaths)

    unregisterModel(modelId)
    clearRegistry()
  })
}

test('completion: kv-cache keeps the file the addon saved for a cancelled first turn', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-cancel-cold-${Date.now()}`
  const calls: RecordedCall[] = []
  const cachePaths: string[] = []
  registerScriptedModel(modelId, calls, cachePaths, { cancelOnRun: 1 })
  const complete = completer(modelId, 'cancel-cold-key')
  await complete([user('Area of a triangle, base 10 height 5?')])

  t.ok(await holdsCommittedBytes(cachePaths.at(-1)), 'the saved prompt prefix is kept')

  unregisterModel(modelId)
  clearRegistry()
})

// An engine-side throw after the addon saved unwinds without a commit; the
// file the previous turn committed is kept.
test('completion: kv-cache keeps a committed file when the engine throws after the save', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-post-save-throw-${Date.now()}`
  const calls: RecordedCall[] = []
  const cachePaths: string[] = []
  registerScriptedModel(modelId, calls, cachePaths, { statsThrowOnRun: 2 })
  const { refusal, fileSurvivedRefusal, turnCalls } = await runRefusalScenario(
    modelId,
    calls,
    cachePaths,
    'post-save-throw-key'
  )
  t.ok(refusal instanceof Error && /stats exploded/.test(refusal.message), 'turn two fails')
  t.ok(fileSurvivedRefusal, 'the committed cache file is still on disk')
  assertRetryReusesCache(t, turnCalls, cachePaths)

  unregisterModel(modelId)
  clearRegistry()
})

// On a first turn there is nothing committed to keep, so the file the failed
// run saved is removed.
test('completion: kv-cache drops the file a first turn saved before the engine threw', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-cold-post-save-throw-${Date.now()}`
  const calls: RecordedCall[] = []
  const cachePaths: string[] = []
  registerScriptedModel(modelId, calls, cachePaths, { statsThrowOnRun: 1 })
  const complete = completer(modelId, 'cold-post-save-throw-key')
  let refusal: unknown
  try {
    await complete([user('Area of a triangle, base 10 height 5?')])
  } catch (error) {
    refusal = error
  }

  const fs = await import('bare-fs')
  t.ok(refusal instanceof Error && /stats exploded/.test(refusal.message), 'the turn fails')
  t.ok(
    cachePaths.length > 0 && !fs.existsSync(cachePaths.at(-1)!),
    'the file this turn saved is not left behind'
  )

  unregisterModel(modelId)
  clearRegistry()
})

// A missing attachment is caller input the SDK rejects before the addon
// runs, so the committed cache must survive and the retry reuses it.
test('completion: kv-cache survives a missing-attachment rejection between turns', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-attachment-preserves-${Date.now()}`
  const calls: RecordedCall[] = []
  const cachePaths: string[] = []
  registerRecordingModel(modelId, calls, { tools: true }, cachePaths)
  const complete = completer(modelId, 'attachment-preserves-key')
  const first = user('Area of a triangle, base 10 height 5?')
  await complete([first])

  const badTurn = [
    first,
    assistant('25.'),
    {
      role: 'user',
      content: 'see attachment',
      attachments: [{ path: '/nonexistent/attachment.png' }]
    }
  ]
  let refusal: unknown
  try {
    await complete(badTurn as HistoryEntry[])
  } catch (error) {
    refusal = error
  }
  t.ok(
    await holdsCommittedBytes(cachePaths.at(-1)),
    'the committed cache bytes survive the rejection'
  )
  t.ok(refusal instanceof AttachmentNotFoundError, 'the caller gets the typed attachment error')

  await complete([first, assistant('25.'), user('And base 4 height 3?')])
  const turnCalls = calls.filter((call) => !call.prefill)
  t.is(turnCalls.length, 2, 'the rejected turn never reached the model')
  t.is(new Set(cachePaths).size, 1, 'the retry uses the committed cache file')

  unregisterModel(modelId)
  clearRegistry()
})

// Every turn re-sends the full history, attachments included, so one deleted
// after an earlier turn fails the next turn as it would without a cache.
test('completion: kv-cache rejects a turn whose earlier attachment vanished from disk', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const fs = await import('bare-fs')
  const os = await import('bare-os')
  const path = await import('bare-path')
  const attachmentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-attachment-'))
  const attachmentPath = path.join(attachmentDir, 'diagram.png')
  fs.writeFileSync(attachmentPath, 'image-bytes')

  const modelId = `kvcache-attachment-vanishes-${Date.now()}`
  try {
    const calls: RecordedCall[] = []
    const cachePaths: string[] = []
    registerRecordingModel(modelId, calls, { tools: true }, cachePaths)
    const complete = completer(modelId, 'attachment-vanishes-key')
    const first = {
      role: 'user',
      content: 'Area of the triangle in the attachment?',
      attachments: [{ path: attachmentPath }]
    }
    await complete([first] as HistoryEntry[])

    fs.unlinkSync(attachmentPath)
    let refusal: unknown
    try {
      await complete([first, assistant('25.'), user('And base 4 height 3?')] as HistoryEntry[])
    } catch (error) {
      refusal = error
    }

    const turnCalls = calls.filter((call) => !call.prefill)
    t.ok(refusal instanceof AttachmentNotFoundError, 'the caller gets the typed attachment error')
    t.is(turnCalls.length, 1, 'the rejected turn never reached the model')
    t.ok(await holdsCommittedBytes(cachePaths.at(-1)), 'the committed cache file survives')
  } finally {
    fs.rmSync(attachmentDir, { recursive: true, force: true })
    unregisterModel(modelId)
    clearRegistry()
  }
})

test('completion: kv-cache seeds the configured system prompt when the history omits one', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-sysprompt-model-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls, {
    tools: true,
    system_prompt: 'Always answer with the single word BANANA.'
  })

  const complete = completer(modelId, 'sysprompt-regression-key')
  const first = user('What is the capital of France?')
  await complete([first])
  await complete([first, assistant('BANANA.'), user('And of Spain?')])

  const turnCalls = calls.filter((call) => !call.prefill)
  t.is(turnCalls.length, 2, 'both turns reached the model')
  for (const [index, call] of turnCalls.entries()) {
    const systemMessages = call.messages.filter((msg) => msg.role === 'system')
    t.is(systemMessages.length, 1, `turn ${index + 1} carries the configured system prompt`)
    t.is(
      systemMessages[0]!.content,
      'Always answer with the single word BANANA.',
      `turn ${index + 1} sends the configured instruction`
    )
  }

  unregisterModel(modelId)
  clearRegistry()
})

test('completion: kv-cache keeps the caller system message over the configured one', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-sysprompt-override-model-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls, {
    tools: true,
    system_prompt: 'Always answer with the single word BANANA.'
  })

  const complete = completer(modelId, 'sysprompt-override-key')
  await complete([
    { role: 'system', content: 'Answer in French.' },
    user('What is the capital of France?')
  ] as HistoryEntry[])

  const turnCalls = calls.filter((call) => !call.prefill)
  const systemMessages = turnCalls[0]!.messages.filter((msg) => msg.role === 'system')
  t.is(systemMessages.length, 1, 'only one system message is sent')
  t.is(systemMessages[0]!.content, 'Answer in French.', 'the caller system message wins')

  unregisterModel(modelId)
  clearRegistry()
})

// `prependToolsToHistory` puts the block after the system message, and a
// template that anchors its tool section on that message renders the two
// orders differently.
test('completion: kv-cache places the tool block after the system message', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-tools-system-order-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)

  const complete = completer(modelId, 'tools-system-order-key')
  const sys = system('Answer in French.')
  const first = user('Area of a triangle, base 10 height 5?')
  await complete([sys, first], [areaTool])
  await complete([sys, first, assistant('25.'), user('And base 4 height 3?')], [areaTool])

  const turnCalls = calls.filter((call) => !call.prefill)
  t.is(turnCalls.length, 2, 'both turns reached the model')
  t.alike(
    shape(turnCalls[0]!),
    ['system', 'tool', 'user'],
    'the tool block sits between the system message and the user turn'
  )
  t.alike(
    shape(turnCalls[1]!),
    ['system', 'tool', 'user', 'assistant', 'user'],
    'the warm turn keeps the same placement'
  )

  unregisterModel(modelId)
  clearRegistry()
})

// -----------------------------------------------------------------------------
// Deferred tools (`deferLoading`). A deferred schema must stay out of the
// prompt until the model searches for it, and loading one must not disturb the
// prefix: the block at the front of the payload has to render identically
// before and after, or the cache diverges at the block and everything behind it
// is re-prefilled.
// -----------------------------------------------------------------------------

function deferredTool(name: string): ToolDef & { deferLoading: boolean; group: string } {
  return { ...makeTool(name), deferLoading: true, group: 'geometry' }
}

test('completion: a deferred tool sends a catalog, not its schema', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-defer-model-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)

  const complete = completer(modelId, 'defer-catalog-key')
  await complete([user('Area of a triangle, base 10 height 5?')], [deferredTool('calculate_area')])

  const turn = calls.filter((call) => !call.prefill).at(-1)
  t.ok(turn)
  t.alike(toolNames(turn!), ['tool_search'], 'only the search tool is declared')

  const searchEntry = turn!.messages.filter(isToolEntry).at(0) as { description?: string }
  t.ok(
    searchEntry.description?.includes('calculate_area'),
    'the deferred tool is named in the catalog'
  )
  t.absent(
    JSON.stringify(turn!.messages).includes('"height"'),
    'no deferred parameter schema reaches the prompt'
  )

  unregisterModel(modelId)
  clearRegistry()
})

test('completion: registration-only fields stay out of the prompt when nothing defers', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-defer-strip-model-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)

  const complete = completer(modelId, 'defer-strip-key')
  await complete(
    [user('Area of a triangle, base 10 height 5?')],
    [{ ...makeTool('calculate_area'), deferLoading: false, group: 'geometry' } as ToolDef]
  )

  const turn = calls.filter((call) => !call.prefill).at(-1)
  t.ok(turn)
  const entry = turn!.messages.filter(isToolEntry).at(0) as Record<string, unknown>
  t.is(entry['name'], 'calculate_area')
  t.absent('deferLoading' in entry, 'deferLoading is not rendered')
  t.absent('group' in entry, 'group is not rendered')

  unregisterModel(modelId)
  clearRegistry()
})

test('completion: loading a deferred tool leaves the prefix block untouched', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-defer-load-model-${Date.now()}`
  const calls: RecordedCall[] = []
  const cachePaths: string[] = []
  registerRecordingModel(modelId, calls, { tools: true }, cachePaths)

  const tools = [deferredTool('calculate_area')]
  const complete = completer(modelId, 'defer-load-key')

  const history = [user('Area of a triangle, base 10 height 5?')]
  await complete(history, tools)
  const before = calls.filter((call) => !call.prefill).at(-1)!

  // The search result the orchestrator would have appended.
  const { executeToolSearch } = await import('@/utils/tools/defer')
  const loaded = executeToolSearch(tools as never, { query: 'calculate_area' }, [])
  await complete(
    [
      ...history,
      { role: 'assistant', content: '<call tool_search>', attachments: [] },
      { role: 'tool', content: loaded, attachments: [] }
    ],
    tools
  )
  const after = calls.filter((call) => !call.prefill).at(-1)!

  t.alike(toolNames(before), ['tool_search'], 'the cold turn declared only the search tool')
  t.alike(
    after.messages.slice(0, before.messages.length),
    before.messages,
    'the warm turn opens with the whole cold prompt, tool block first'
  )
  t.alike(
    after.messages.filter(isToolEntry),
    before.messages.filter(isToolEntry),
    'loading a definition does not change the declared block'
  )
  t.is(new Set(cachePaths).size, 1, 'loading a definition does not open a second cache file')
  t.is(before.toolChoice, undefined, 'nothing loaded yet: the tool grammar stays on')
  t.is(after.toolChoice, 'none', 'the loaded tool is outside the grammar, so it is turned off')

  unregisterModel(modelId)
  clearRegistry()
})
