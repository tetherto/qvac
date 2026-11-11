import test from 'brittle'
import Buffer from 'bare-buffer'
import fs from 'bare-fs'
import http from 'bare-http1'
import os from 'bare-os'
import path from 'bare-path'
import { getRequestRegistry } from '@/runtime/index'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { textToSpeech } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'
import { textToSpeechStream } from '@/plugins/builtin/tts-ggml/ops/text-to-speech-stream'
import type { TtsOpResult } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'
import { getModelsCacheDir } from '@/utils/cache/paths'
import { useTestCacheDir } from './fixtures/test-cache'

// The per-request voice controls @qvac/tts-ggml takes on every entry point:
// CosyVoice3's `instruct` and Audio8's reference recording + transcript. The
// request schema only knows an opaque modelId, so the engine check runs in the
// op, and the forwarded job must carry exactly the fields the request set.

const response = {
  stats: { totalSamples: 2 },
  async *iterate() {
    yield { outputArray: new Int16Array([1, 2]), sampleRate: 24000 }
  }
}

function fakeModel(engine: string, calls: unknown[]) {
  return {
    getEngineType: () => engine,
    async cancel() {},
    async run(job: unknown) {
      calls.push(job)
      return response
    },
    async runStream(text: string, options: unknown) {
      calls.push({ text, options })
      return response
    },
    async runStreaming(source: AsyncIterable<string>, options: unknown) {
      const text: string[] = []
      for await (const fragment of source) text.push(fragment)
      calls.push({ text: text.join(''), options })
      return response
    }
  }
}

function register(modelId: string, engine: string, calls: unknown[]) {
  registerModel(modelId, {
    model: fakeModel(engine, calls) as never,
    path: `/tmp/${engine}.gguf`,
    config: { ttsEngine: engine },
    modelType: 'tts-ggml'
  })
}

async function drain(op: AsyncGenerator<unknown, TtsOpResult, unknown>) {
  let result = await op.next()
  while (!result.done) result = await op.next()
  return result.value
}

function duplex(request: Record<string, unknown>, text: string) {
  return textToSpeechStream(
    { type: 'textToSpeechStream', inputType: 'text', ...request } as never,
    (async function* () {
      yield Buffer.from(text)
    })()
  )
}

// A loopback server that accepts the reference download and never answers it,
// which parks the op in the fetch for as long as a test needs. `requested`
// settles once the download has reached the server, so a test cancels at a
// known point instead of racing the op.
async function startStalledServer() {
  let onRequest!: () => void
  const requested = new Promise<void>((resolve) => {
    onRequest = resolve
  })
  const sockets = new Set<{ destroy: () => void }>()
  const server = http.createServer(() => onRequest())
  server.on('connection', (socket: { destroy: () => void }) => sockets.add(socket))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address()!
  return {
    url: `http://127.0.0.1:${port}/someone-else.wav`,
    requested,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([work, expiry])
  } finally {
    clearTimeout(timer!)
  }
}

test('CosyVoice3: a per-request instruct reaches run(), runStream() and runStreaming()', async (t) => {
  const calls: unknown[] = []
  register('cosyvoice3-instruct', 'cosyvoice3', calls)
  try {
    await drain(
      textToSpeech({
        type: 'textToSpeech',
        modelId: 'cosyvoice3-instruct',
        inputType: 'text',
        text: 'Hello there.',
        stream: false,
        sentenceStream: false,
        instruct: { dialect: 'cantonese' }
      })
    )
    t.alike(calls[0], {
      input: 'Hello there.',
      type: 'text',
      instruct: { dialect: 'cantonese' }
    })

    await drain(
      textToSpeech({
        type: 'textToSpeech',
        modelId: 'cosyvoice3-instruct',
        inputType: 'text',
        text: 'Hello there.',
        stream: true,
        sentenceStream: true,
        instruct: '请用四川话表达。'
      })
    )
    t.alike(calls[1], {
      text: 'Hello there.',
      options: { instruct: '请用四川话表达。' }
    })

    await drain(duplex({ modelId: 'cosyvoice3-instruct', instruct: { volume: 'soft' } }, 'Hi.'))
    t.alike(calls[2], { text: 'Hi.', options: { instruct: { volume: 'soft' } } })
  } finally {
    unregisterModel('cosyvoice3-instruct')
  }
})

test('CosyVoice3: a request without voice fields forwards no voice keys', async (t) => {
  const calls: unknown[] = []
  register('cosyvoice3-plain', 'cosyvoice3', calls)
  try {
    await drain(
      textToSpeech({
        type: 'textToSpeech',
        modelId: 'cosyvoice3-plain',
        inputType: 'text',
        text: 'Hello there.',
        stream: false,
        sentenceStream: false
      })
    )
    // No explicit-undefined keys: the addon's exactOptionalPropertyTypes
    // typing and its "engine X does not take Y" checks read key presence.
    t.alike(Object.keys(calls[0] as object).sort(), ['input', 'type'])
  } finally {
    unregisterModel('cosyvoice3-plain')
  }
})

test('Audio8: the per-request reference pair is resolved to a path and forwarded', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-voice-options-'))
  const reference = path.join(dir, 'someone-else.wav')
  fs.writeFileSync(reference, Buffer.from('RIFF'))
  const calls: unknown[] = []
  register('audio8-voice', 'audio8', calls)
  try {
    await drain(
      textToSpeech({
        type: 'textToSpeech',
        modelId: 'audio8-voice',
        inputType: 'text',
        text: 'Spoken in another voice.',
        stream: false,
        sentenceStream: false,
        referenceAudioSrc: reference,
        referenceText: 'What that recording says.'
      })
    )
    t.alike(calls[0], {
      input: 'Spoken in another voice.',
      type: 'text',
      referenceAudio: reference,
      referenceText: 'What that recording says.'
    })

    // A transcript alone corrects the loaded recording's transcript.
    await drain(duplex({ modelId: 'audio8-voice', referenceText: 'Corrected transcript.' }, 'Hi.'))
    t.alike(calls[1], { text: 'Hi.', options: { referenceText: 'Corrected transcript.' } })
  } finally {
    unregisterModel('audio8-voice')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('per-request instruct is rejected on engines other than CosyVoice3', async (t) => {
  const calls: unknown[] = []
  register('chatterbox-instruct', 'chatterbox', calls)
  try {
    await t.exception(
      drain(
        textToSpeech({
          type: 'textToSpeech',
          modelId: 'chatterbox-instruct',
          inputType: 'text',
          text: 'Hello.',
          stream: false,
          sentenceStream: false,
          instruct: 'speak softly'
        })
      ),
      /CosyVoice3/
    )
    await t.exception(
      drain(duplex({ modelId: 'chatterbox-instruct', instruct: 'speak softly' }, 'Hello.')),
      /CosyVoice3/
    )
    t.is(calls.length, 0, 'nothing reached the engine')
  } finally {
    unregisterModel('chatterbox-instruct')
  }
})

test('per-request referenceText is rejected on engines other than Audio8', async (t) => {
  const calls: unknown[] = []
  register('cosyvoice3-reference', 'cosyvoice3', calls)
  try {
    await t.exception(
      drain(
        textToSpeech({
          type: 'textToSpeech',
          modelId: 'cosyvoice3-reference',
          inputType: 'text',
          text: 'Hello.',
          stream: false,
          sentenceStream: false,
          referenceText: 'a transcript'
        })
      ),
      /Audio8/
    )
    t.is(calls.length, 0, 'nothing reached the engine')
  } finally {
    unregisterModel('cosyvoice3-reference')
  }
})

// An uncached remote `referenceAudioSrc` downloads before the engine is asked
// for anything. That wait is part of the request: it has to be in the registry
// for `cancel({ modelId })` to find it, and the transfer has to be bound to it
// for either cancel to stop the fetch rather than be followed by synthesis.
test('Audio8: a model-scoped cancel stops the reference download before any synthesis', async (t) => {
  useTestCacheDir()
  const modelId = 'audio8-reference-cancel'
  const requestId = 'req-reference-cancel'
  const server = await startStalledServer()
  const calls: unknown[] = []
  register(modelId, 'audio8', calls)
  t.teardown(async () => {
    unregisterModel(modelId)
    await server.close()
  })

  const pending = drain(
    textToSpeech({
      type: 'textToSpeech',
      modelId,
      requestId,
      inputType: 'text',
      text: 'Spoken in another voice.',
      stream: false,
      sentenceStream: false,
      referenceAudioSrc: server.url,
      referenceText: 'What that recording says.'
    })
  )
  await withTimeout(server.requested, 5000, 'the reference download never reached the server')

  t.is(
    getRequestRegistry().cancel({ modelId }),
    1,
    'the request is registered while its reference recording downloads'
  )
  const result = await withTimeout(pending, 5000, 'the cancel did not stop the download')
  t.is(result.cancelled, true, 'the op reports the cancellation')
  t.is(calls.length, 0, 'nothing reached the engine')
  t.is(getRequestRegistry().get(requestId), null, 'the model slot is released')
})

test('Audio8: cancelling by requestId stops a duplex session still fetching its reference', async (t) => {
  useTestCacheDir()
  const modelId = 'audio8-reference-cancel-duplex'
  const requestId = 'req-reference-cancel-duplex'
  const server = await startStalledServer()
  const calls: unknown[] = []
  register(modelId, 'audio8', calls)
  t.teardown(async () => {
    unregisterModel(modelId)
    await server.close()
  })

  const pending = drain(
    duplex(
      {
        modelId,
        requestId,
        referenceAudioSrc: server.url,
        referenceText: 'What that recording says.'
      },
      'Hi.'
    )
  )
  await withTimeout(server.requested, 5000, 'the reference download never reached the server')

  t.is(getRequestRegistry().cancel({ requestId }), 1, 'the request is addressable by its id')
  const result = await withTimeout(pending, 5000, 'the cancel did not stop the download')
  t.is(result.cancelled, true, 'the op reports the cancellation')
  t.is(calls.length, 0, 'nothing reached the engine')
  t.is(getRequestRegistry().get(requestId), null, 'the model slot is released')
})

// Fires `onTouch` the moment the source resolver checks `target` on disk, then
// lets the check succeed: a cancel that lands while a cached reference is being
// resolved, at a known point instead of racing the op.
function whenResolverTouches(target: string, onTouch: () => void) {
  const promises = fs.promises as unknown as {
    access: (file: string, ...rest: unknown[]) => Promise<void>
  }
  const original = promises.access
  let touched = false
  promises.access = async function (file: string, ...rest: unknown[]) {
    if (!touched && file === target) {
      touched = true
      onTouch()
    }
    return original.call(promises, file, ...rest)
  }
  return {
    wasTouched: () => touched,
    restore: () => {
      promises.access = original
    }
  }
}

// A `referenceAudioSrc` naming a file already in the cache resolves through a
// file check that no abort signal interrupts, so a cancel during that wait
// leaves the resolution successful. The op's abort listener has by then spent
// its once-only `model.cancel()` on a model with no job, so the request must
// stop here rather than start one.
for (const entry of ['textToSpeech', 'textToSpeechStream'] as const) {
  test(`Audio8 ${entry}: a cancel while a cached reference resolves starts no synthesis`, async (t) => {
    useTestCacheDir()
    const modelId = `audio8-reference-resolved-cancel-${entry}`
    const requestId = `req-reference-resolved-cancel-${entry}`
    // A bare filename is looked up in the models cache.
    const reference = `someone-else-${entry}.wav`
    const cached = path.join(getModelsCacheDir(), reference)
    fs.mkdirSync(path.dirname(cached), { recursive: true })
    fs.writeFileSync(cached, Buffer.from('RIFF'))
    const calls: unknown[] = []
    register(modelId, 'audio8', calls)
    let cancelled = 0
    const hook = whenResolverTouches(cached, () => {
      cancelled = getRequestRegistry().cancel({ requestId })
    })
    t.teardown(() => {
      hook.restore()
      unregisterModel(modelId)
      fs.rmSync(cached, { force: true })
    })

    const voice = { referenceAudioSrc: reference, referenceText: 'What that recording says.' }
    const op =
      entry === 'textToSpeech'
        ? textToSpeech({
            type: 'textToSpeech',
            modelId,
            requestId,
            inputType: 'text',
            text: 'Spoken in another voice.',
            stream: false,
            sentenceStream: false,
            ...voice
          })
        : duplex({ modelId, requestId, ...voice }, 'Hi.')
    const result = await withTimeout(drain(op), 5000, 'the cancelled request never settled')

    t.ok(hook.wasTouched(), 'the reference was resolved from the cache')
    t.is(cancelled, 1, 'the cancel landed on the registered request during the resolution')
    t.is(result.cancelled, true, 'the op reports the cancellation')
    t.is(calls.length, 0, 'nothing reached the engine')
    t.is(getRequestRegistry().get(requestId), null, 'the model slot is released')
  })
}
