import test from 'brittle'
import { ttsConfigSchema, ttsClientParamsSchema } from '@/schemas/text-to-speech'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { textToSpeech } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'
import { modelFitCandidateSchema } from '@/schemas/assess-model-fit'
import { getMossJobOptions } from '@/plugins/builtin/tts-ggml/ops/moss-options'

const sfx = { ttsEngine: 'moss-sfx', steps: 20, guidance: 4, shift: 5 }
const speech = { ttsEngine: 'moss-speech', mossSpeechCodecModelSrc: '/models/codec.gguf' }

test('MOSS load and request schemas accept native controls and reject invalid bounds', (t) => {
  t.ok(ttsConfigSchema.safeParse(sfx).success)
  t.ok(ttsConfigSchema.safeParse(speech).success)
  t.absent(ttsConfigSchema.safeParse({ ttsEngine: 'moss-speech' }).success)
  t.absent(ttsConfigSchema.safeParse({ ...sfx, seconds: 31 }).success)
  t.absent(ttsConfigSchema.safeParse({ ...sfx, useGPU: false, nGpuLayers: 99 }).success)
  const request = { modelId: 'speech', stream: false, audio: [0, 0.5], sampleRate: 16000 }
  t.ok(ttsClientParamsSchema.safeParse(request).success)
  t.absent(ttsClientParamsSchema.safeParse({ ...request, text: 'also text' }).success)
  t.absent(ttsClientParamsSchema.safeParse({ ...request, sampleRate: undefined }).success)
  t.absent(ttsClientParamsSchema.safeParse({ ...request, maxNewTokens: 4097 }).success)
  t.absent(ttsClientParamsSchema.safeParse({ ...request, replyVoice: [0] }).success)
})

test('MOSS-Speech forwards PCM, conversation and token options and returns text-only replies', async (t) => {
  const modelId = 'moss-speech-011'
  let job: Record<string, unknown> | undefined
  const model = {
    getEngineType: () => 'moss-speech',
    cancel: async () => {},
    run: async (input: Record<string, unknown>) => {
      job = input
      return {
        iterate: async function* () {
          yield { outputArray: [], sampleRate: 24000, text: 'Hello.' }
        }
      }
    }
  }
  registerModel(modelId, {
    model: model as never,
    path: '/models/speech.gguf',
    config: speech,
    modelType: 'tts-ggml'
  })
  try {
    const request = {
      type: 'textToSpeech' as const,
      modelId,
      inputType: 'text',
      stream: true,
      sentenceStream: false,
      audio: [0, 0.5],
      sampleRate: 16000,
      textReply: true,
      messages: [{ role: 'user' as const, text: 'Earlier turn.' }],
      systemPrompt: 'Answer briefly.'
    }
    const stream = textToSpeech(request)
    const first = await stream.next()
    t.alike(first.value, { buffer: [], sampleRate: 24000, text: 'Hello.' })
    await stream.next()
    t.ok(job?.['audio'] instanceof Float32Array)
    t.alike(job?.['messages'], request.messages)
    t.is(job?.['maxNewTokens'], undefined, 'omitted token budget stays omitted')
    t.exception(
      () => getMossJobOptions(model, { ...request, sentenceStream: true }),
      /sentence-stream/
    )
    t.exception(() => getMossJobOptions(model, { ...request, seconds: 3 }), /requires moss-sfx/)
  } finally {
    unregisterModel(modelId)
  }
})

test('MOSS-SoundEffect passes load defaults and per-call overrides without sentence chunking', async (t) => {
  const modelId = 'moss-sfx-011'
  let job: Record<string, unknown> | undefined
  const model = {
    getEngineType: () => 'moss-sfx',
    cancel: async () => {},
    run: async (input: Record<string, unknown>) => {
      job = input
      return {
        iterate: async function* () {
          yield { outputArray: [0.1], sampleRate: 48000 }
        }
      }
    }
  }
  registerModel(modelId, {
    model: model as never,
    path: '/models/sfx.gguf',
    config: { ...sfx, seconds: 3, negativePrompt: 'voices' },
    modelType: 'tts-ggml'
  })
  try {
    const request = {
      type: 'textToSpeech' as const,
      modelId,
      inputType: 'text',
      text: 'Rain.',
      stream: true,
      sentenceStream: false,
      steps: 10
    }
    const run = textToSpeech(request)
    t.alike((await run.next()).value, { buffer: [0.1], sampleRate: 48000 })
    await run.next()
    t.alike(job, {
      input: 'Rain.',
      type: 'text',
      seconds: 3,
      negativePrompt: 'voices',
      steps: 10,
      guidance: 4,
      shift: 5
    })
    t.exception(
      () => getMossJobOptions(model, { ...request, sentenceStream: true }),
      /sentence-stream/
    )
  } finally {
    unregisterModel(modelId)
  }
})

test('MOSS fit workloads belong to the assessment candidate, not load configuration', (t) => {
  const workload = { prompt: 'Rain', seconds: 2 }
  t.ok(
    modelFitCandidateSchema.safeParse({
      modelType: 'tts-ggml',
      modelConfig: sfx,
      ttsWorkload: workload
    }).success
  )
  t.absent(ttsConfigSchema.safeParse({ ...sfx, fitWorkload: workload }).success)
  t.absent(modelFitCandidateSchema.safeParse({ ttsWorkload: { ...workload, seconds: 31 } }).success)
})
