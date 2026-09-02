import test from 'brittle'
import { AttachmentNotFoundError } from '@/errors/index'
import { llmPlugin } from '@/plugins/builtin/llamacpp-completion/plugin'
import {
  clearRegistry,
  registerModel,
  unregisterModel,
  type AnyModel
} from '@/runtime/model-registry'
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
// These tests pin the split that avoids it — nothing but the system prompt
// goes into the prefix, and the tools travel with a turn — plus the three ways
// "the block is already cached" can be wrong: a changed tool set, a turn whose
// message list the template won't render tools for, and a sliding context
// window that can evict the block.
//
// Requires the Bare runtime (the plugin pulls in the N-API addon at import).
// -----------------------------------------------------------------------------

type LooseHandler = (request: unknown) => AsyncGenerator<unknown, unknown, unknown>

type RecordedCall = {
  messages: { role?: string; type?: string; name?: string }[]
  prefill: boolean
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

// The session refuses to continue unless the prime left a non-empty cache
// file behind, so the stand-in addon has to produce one.
async function writeCacheFile(cachePath: string): Promise<void> {
  const fs = await import('bare-fs')
  const path = await import('bare-path')
  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  fs.writeFileSync(cachePath, 'primed')
}

/**
 * Stand-in for the addon that records every payload it is handed and reports
 * a cache file for whatever key it was told to save under.
 */
function registerRecordingModel(
  modelId: string,
  calls: RecordedCall[],
  config: Record<string, unknown> = { tools: true },
  cachePaths?: string[]
): void {
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
          stats: {}
        }
      }
    } as unknown as AnyModel,
    path: `/tmp/${modelId}.gguf`,
    config,
    modelType: ModelType.llamacppCompletion
  })
}

function completer(modelId: string, kvCacheKey: string) {
  const handler = llmPlugin.handlers.completionStream.handler as unknown as LooseHandler
  let request = 0
  return async (history: HistoryEntry[], tools?: ToolDef[]): Promise<void> => {
    request += 1
    const gen = handler({
      modelId,
      requestId: `${modelId}-${request}`,
      history,
      stream: true,
      kvCache: kvCacheKey,
      ...(tools ? { tools } : {})
    })
    for await (const _ of gen) void _
  }
}

test('completion: kv-cache keeps tools out of the prefix and sends them with the turn', async (t) => {
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
    toolNames(turnCalls[0]!),
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

// Static placement never trims the tool block back out of the cache, so a
// block that travels on every turn leaves one copy per turn and grows the
// prefix with the conversation. It only needs to enter the cache once.
test('completion: kv-cache sends the tool block once, not on every warm turn', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-tools-multiturn-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)

  const complete = completer(modelId, 'tools-multiturn-key')
  const first = user('Area of a triangle, base 10 height 5?')
  const reply = assistant('The area is 25 square units.')
  const second = user('And with base 4 height 3?')

  await complete([first], [areaTool])
  await complete([first, reply, second], [areaTool])

  const primeCalls = calls.filter((call) => call.prefill)
  const turnCalls = calls.filter((call) => !call.prefill)

  t.is(primeCalls.length, 1, 'the prefix was primed once across both turns')
  t.is(turnCalls.length, 2, 'both turns reached the model')

  t.alike(
    toolNames(turnCalls[0]!),
    ['calculate_triangle_area'],
    'the first turn writes the tool block into the cache'
  )
  t.absent(
    turnCalls[1]!.messages.some(isToolEntry),
    'the warm turn does not append a second copy of the tool block'
  )
  t.alike(
    turnCalls[1]!.messages.map((msg) => msg.role),
    ['user'],
    'the warm turn sends only the unsaved tail'
  )

  unregisterModel(modelId)
  clearRegistry()
})

// The send-once gate must not key off the turn's saved count, which records
// that history was committed — not that this tool block is the one in the
// cache. A tool set that shows up after a tools-free turn, or changes
// mid-session, must still reach the model: it keys into its own cache through
// `configHash`, which primes fresh and so passes the gate.
test('completion: kv-cache sends a tool set that appears late or changes', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-tools-changing-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)

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
    'a tool set that appears after a tools-free turn still reaches the model'
  )
  t.alike(
    toolNames(turnCalls[2]!),
    ['calculate_triangle_area', 'calculate_perimeter'],
    'a changed tool set reaches the model instead of reusing the cached block'
  )

  unregisterModel(modelId)
  clearRegistry()
})

// Sending the block is not the same as the model seeing it. When the payload
// has no user message, Qwen-family templates raise and the addon re-renders
// with the tools stripped, returning a usable prompt and no error. Treating
// that turn as "the block is cached now" loses tools for the whole session.
test('completion: kv-cache resends the tool block after a turn that could not render it', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-tools-unrendered-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls)

  const complete = completer(modelId, 'tools-unrendered-key')
  // An assistant-continuation seed: no user turn anywhere for the template to
  // anchor its tool block on.
  const seeded = [system('You are helpful.'), assistant('Shall I continue?')]
  await complete(seeded, [areaTool])
  await complete([...seeded, assistant('Continuing.'), user('Area, base 10 height 5?')], [areaTool])

  const turnCalls = calls.filter((call) => !call.prefill)
  t.is(turnCalls.length, 2, 'both turns reached the model')

  t.alike(
    toolNames(turnCalls[0]!),
    ['calculate_triangle_area'],
    'the tool block travels with the first turn even though it cannot render'
  )
  t.absent(
    turnCalls[0]!.messages.some((msg) => msg.role === 'user'),
    'that first payload has no user message to anchor the block on'
  )
  t.alike(
    toolNames(turnCalls[1]!),
    ['calculate_triangle_area'],
    'the next turn resends the block instead of trusting the unrendered one'
  )

  unregisterModel(modelId)
  clearRegistry()
})

// `n_discarded` is retired, so a config that still carries it must not change
// caching: the warm turn skips the tool block like any other.
test('completion: kv-cache still skips the tool block when a retired slide key is present', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-tools-retired-slide-key-${Date.now()}`
  const calls: RecordedCall[] = []
  registerRecordingModel(modelId, calls, { tools: true, n_discarded: 64 })

  const complete = completer(modelId, 'tools-retired-slide-key')
  const first = user('Area of a triangle, base 10 height 5?')
  await complete([first], [areaTool])
  await complete([first, assistant('25.'), user('And base 4 height 3?')], [areaTool])

  const turnCalls = calls.filter((call) => !call.prefill)
  t.is(turnCalls.length, 2, 'both turns reached the model')

  t.alike(
    toolNames(turnCalls[0]!),
    ['calculate_triangle_area'],
    'the first turn carries the tool block'
  )
  t.alike(
    toolNames(turnCalls[1]!),
    [],
    'the warm turn does not resend it, the retired key no longer forces a resend'
  )

  unregisterModel(modelId)
  clearRegistry()
})

// The fake throws on the second non-prefill run, so a refusal between two
// committed turns can be pinned against the cache bookkeeping.
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

// Turn one commits, turn two is refused by the fake, turn three retries the
// same history. Returns the refusal and the non-prefill calls for assertion.
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
  // Bookkeeping surviving is not enough — the committed bytes must still be
  // on disk, unmodified, between the refusal and the retry.
  const fs = await import('bare-fs')
  const committedPath = cachePaths[cachePaths.length - 1]
  const fileSurvivedRefusal =
    committedPath !== undefined &&
    fs.existsSync(committedPath) &&
    fs.readFileSync(committedPath, 'utf8') === 'primed'
  await complete(grown)
  return { refusal, fileSurvivedRefusal, turnCalls: calls.filter((call) => !call.prefill) }
}

// A prefill-guard overflow rejects before any decode or save, so it must not
// destroy the last committed cache — the next turn stays warm.
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
  t.is(turnCalls.length, 3, 'all three turns reached the model')
  t.is(turnCalls[2]!.messages.length, 1, 'the retry is warm — a delta, not a re-primed history')

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
  t.is(turnCalls.length, 3, 'all three turns reached the model')
  t.is(turnCalls[2]!.messages.length, 1, 'the retry is warm — a delta, not a re-primed history')

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
  t.is(turnCalls.length, 3, 'all three turns reached the model')
  t.is(turnCalls[2]!.messages.length, 1, 'the retry is warm — a delta, not a re-primed history')

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
  t.is(turnCalls.length, 3, 'all three turns reached the model')
  t.is(turnCalls[2]!.messages.length, 1, 'the retry is warm — a delta, not a re-primed history')

  unregisterModel(modelId)
  clearRegistry()
})

// A recognised refusal on the FIRST turn has no committed cache to keep —
// the fresh prime is rolled back and the retry re-primes from scratch.
test('completion: kv-cache drops the fresh prime when the first turn is refused', async (t) => {
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
    'the fresh prime is not left behind'
  )

  await complete([first])
  t.is(calls.filter((call) => call.prefill).length, 2, 'the retry re-primes from scratch')
  t.is(calls.filter((call) => !call.prefill).length, 2, 'the retry turn reaches the model')

  unregisterModel(modelId)
  clearRegistry()
})

// An unrecognised failure may have dirtied KV state, so the destructive
// default must hold: the cache file is unlinked and the retry starts cold.
test('completion: kv-cache rolls back on an unrecognised addon failure between turns', async (t) => {
  await setIsolatedHome()
  clearRegistry()

  const modelId = `kvcache-unknown-rolls-back-${Date.now()}`
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
    'unknown-rolls-back-key'
  )
  t.absent(fileSurvivedRefusal, 'the cache file is unlinked after an unrecognised failure')
  t.ok(refusal instanceof Error && /exploded mid-decode/.test(refusal.message), 'turn two fails')
  t.is(turnCalls.length, 3, 'all three turns reached the model')
  t.ok(turnCalls[2]!.messages.length > 1, 'the retry is cold — the full history is re-sent')

  unregisterModel(modelId)
  clearRegistry()
})

// A missing attachment is caller input the SDK rejects before the addon
// runs, so the committed warm cache must survive and the retry stays warm.
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
  const fs = await import('bare-fs')
  const committedPath = cachePaths[cachePaths.length - 1]!
  t.ok(
    fs.existsSync(committedPath) && fs.readFileSync(committedPath, 'utf8') === 'primed',
    'the committed cache bytes survive the rejection'
  )
  t.ok(refusal instanceof AttachmentNotFoundError, 'the caller gets the typed attachment error')

  await complete([first, assistant('25.'), user('And base 4 height 3?')])
  const turnCalls = calls.filter((call) => !call.prefill)
  t.is(turnCalls.length, 2, 'the rejected turn never reached the model')
  t.is(turnCalls[1]!.messages.length, 1, 'the retry is warm — a delta, not a re-primed history')

  unregisterModel(modelId)
  clearRegistry()
})

// An attachment already inside the committed prefix is never re-read from
// disk — the warm delta skips it, so its later deletion must not fail the turn.
test('completion: kv-cache tolerates a cached attachment vanishing from disk', async (t) => {
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
    registerRecordingModel(modelId, calls)
    const complete = completer(modelId, 'attachment-vanishes-key')
    const first = {
      role: 'user',
      content: 'Area of the triangle in the attachment?',
      attachments: [{ path: attachmentPath }]
    }
    await complete([first] as HistoryEntry[])

    fs.unlinkSync(attachmentPath)
    await complete([first, assistant('25.'), user('And base 4 height 3?')] as HistoryEntry[])

    const turnCalls = calls.filter((call) => !call.prefill)
    t.is(turnCalls.length, 2, 'both turns reached the model')
    t.is(
      turnCalls[1]!.messages.length,
      1,
      'the second turn is warm — the cached attachment is skipped'
    )
  } finally {
    fs.rmSync(attachmentDir, { recursive: true, force: true })
    unregisterModel(modelId)
    clearRegistry()
  }
})
