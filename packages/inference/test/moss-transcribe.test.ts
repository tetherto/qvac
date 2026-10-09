import test from 'brittle'
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
  t.alike(options, [{ hotwords: ['QVAC'], maxNewTokens: 0 }, {}])
})
