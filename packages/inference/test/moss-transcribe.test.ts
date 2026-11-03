import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { FFmpegDecoder } from '@qvac/decoder-audio'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { transcribe } from '@/plugins/ops/transcribe'
import { mossTranscribePlugin } from '@/plugins/builtin/moss-transcribe/plugin'
import { ModelType, loadModelRequestSchema } from '@/schemas/index'

test('MOSS load request accepts GPU configuration and rejects streaming knobs', (t) => {
  const request = {
    type: 'loadModel',
    modelType: ModelType.mossTranscribe,
    modelSrc: '/tmp/moss.gguf'
  }
  t.ok(
    loadModelRequestSchema.safeParse({ ...request, modelConfig: { useGPU: true, maxThreads: 4 } })
      .success
  )
  // The native selector is passed through as given: the engine, not the
  // schema, knows which devices this build has.
  for (const backend of ['auto', 'cpu', 'cuda', 'vulkan', 'metal', 'CUDA0']) {
    t.ok(
      loadModelRequestSchema.safeParse({ ...request, modelConfig: { backend } }).success,
      backend
    )
  }
  t.absent(loadModelRequestSchema.safeParse({ ...request, modelConfig: { backend: 1 } }).success)
  t.absent(
    loadModelRequestSchema.safeParse({ ...request, modelConfig: { streaming: true } }).success
  )
  t.absent('transcribeStream' in mossTranscribePlugin.handlers)
})

test('MOSS batch op forwards hotwords per request without reloading', async (t) => {
  const options: unknown[] = []
  const model = {
    async run(_audio: unknown, requestOptions: unknown) {
      options.push(requestOptions)
      return {
        async *iterate() {
          yield { text: 'QVAC', start: 1, end: 2, speaker: 'S01', speakerId: 0 }
        }
      }
    }
  } as unknown as AnyModel
  const modelId = 'moss-request-options-test'
  registerModel(modelId, { model, path: '', config: {}, modelType: ModelType.mossTranscribe })
  t.teardown(() => unregisterModel(modelId))
  const request = {
    modelId,
    audioChunk: { type: 'base64' as const, value: 'AAA=' },
    metadata: true as const
  }
  const first = transcribe({ ...request, hotwords: ['QVAC'], maxNewTokens: 0 })
  t.alike((await first.next()).value, {
    text: 'QVAC',
    startMs: 1000,
    endMs: 2000,
    append: false,
    id: 0,
    speaker: 'S01',
    speakerId: 0
  })
  await first.next()
  const second = transcribe(request)
  await second.next()
  await second.next()
  const third = transcribe({ ...request, prompt: 'Transcribe the recording.', hotwords: [] })
  await third.next()
  await third.next()
  t.alike(options, [
    { hotwords: ['QVAC'], maxNewTokens: 0 },
    {},
    { prompt: 'Transcribe the recording.', hotwords: [] }
  ])
})

test('MOSS batch op maps the engine stats reported under its own names', async (t) => {
  // MossTranscribeModel::runtimeStats() names its counters differently from
  // whisper and parakeet; the terminal stats carry every one of them.
  const model = {
    async run() {
      return {
        stats: {
          totalTime: 460,
          realTimeFactor: 0.14,
          audioDurationMs: 3400,
          segments: 2,
          audioTokens: 42,
          promptTokens: 18,
          generatedTokens: 40,
          encodeMs: 120,
          prefillMs: 40,
          decodeMs: 300,
          backendDevice: 1,
          backendId: 1
        },
        async *iterate() {
          yield { text: 'QVAC', start: 1, end: 2, speaker: 'S01', speakerId: 0 }
        }
      }
    }
  } as unknown as AnyModel
  const modelId = 'moss-stats-mapping-test'
  registerModel(modelId, { model, path: '', config: {}, modelType: ModelType.mossTranscribe })
  t.teardown(() => unregisterModel(modelId))

  const run = transcribe({ modelId, audioChunk: { type: 'base64' as const, value: 'AAA=' } })
  let result = await run.next()
  while (!result.done) result = await run.next()
  t.alike(result.value.stats, {
    audioDuration: 3400,
    realTimeFactor: 0.14,
    totalSegments: 2,
    encoderTime: 120,
    decoderTime: 300,
    backendDevice: 1,
    backendId: 1,
    totalTime: 460,
    prefillTime: 40,
    audioTokens: 42,
    promptTokens: 18,
    generatedTokens: 40
  })
})

for (const modelType of [
  ModelType.whispercppTranscription,
  ModelType.parakeetTranscription,
  ModelType.mossTranscribe
]) {
  const rejectedOptions =
    modelType === ModelType.mossTranscribe
      ? [{ hotwords: ['QVAC'] }]
      : [{ hotwords: [] }, { maxNewTokens: 0 }]
  for (const options of rejectedOptions) {
    test(`${modelType} rejects ${Object.keys(options)[0]} before prompting or decoding`, async (t) => {
      let decoderLoads = 0
      let promptReloads = 0
      let modelRuns = 0
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-option-rejection-'))
      const audioPath = path.join(directory, 'corrupt.mp3')
      fs.writeFileSync(audioPath, 'invalid compressed audio')
      const originalLoad = FFmpegDecoder.prototype.load
      const originalUnload = FFmpegDecoder.prototype.unload
      FFmpegDecoder.prototype.load = async function () {
        decoderLoads++
        throw new Error('Rejected options started decoding')
      }
      FFmpegDecoder.prototype.unload = async function () {}
      const modelId = `reject-moss-options-${modelType}`
      const model = {
        async reload() {
          promptReloads++
        },
        async run() {
          modelRuns++
          throw new Error('Rejected options started inference')
        }
      } as unknown as AnyModel
      registerModel(modelId, { model, path: '', config: {}, modelType })
      t.teardown(() => {
        unregisterModel(modelId)
        FFmpegDecoder.prototype.load = originalLoad
        FFmpegDecoder.prototype.unload = originalUnload
        fs.rmSync(directory, { recursive: true, force: true })
      })
      const request = transcribe({
        modelId,
        audioChunk: { type: 'filePath', value: audioPath },
        prompt: 'Names used in this recording',
        ...options
      })
      await t.exception(
        request.next(),
        modelType === ModelType.mossTranscribe
          ? /MOSS prompt cannot be combined with hotwords/
          : /require a MOSS-Transcribe-Diarize model/
      )
      t.is(decoderLoads, 0, 'compressed audio decoder never starts')
      t.is(promptReloads, 0, 'Whisper prompt configuration is untouched')
      t.is(modelRuns, 0, 'inference never starts')
    })
  }
}
