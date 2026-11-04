import test from 'brittle'
import Buffer from 'bare-buffer'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { textToSpeech } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'
import { textToSpeechStream } from '@/plugins/builtin/tts-ggml/ops/text-to-speech-stream'
import type { TtsOpResult } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'

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
