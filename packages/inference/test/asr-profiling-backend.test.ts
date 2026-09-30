import test from 'brittle'
import Buffer from 'bare-buffer'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { parakeetPlugin } from '@/plugins/builtin/parakeet-transcription/plugin'
import { whisperPlugin } from '@/plugins/builtin/whispercpp-transcription/plugin'
import { buildOperationEvent } from '@/profiling'
import { ModelType, type CanonicalModelType } from '@/schemas/index'

// Drives each real ASR handler and replays its last chunk into
// buildOperationEvent — exactly what the profiling wrapper passes as
// `finalResponse` — so this proves the diagnostics symbol survives from the
// handler into `event.backend`, not only that it gets attached.

const METAL = { selectedBackend: 'metal', selectedDevice: 'gpu', graphicsApi: 'metal' }

function register(
  t: { teardown(fn: () => void): void },
  modelId: string,
  modelType: CanonicalModelType
) {
  const response = () => ({
    stats: { backendDevice: 1, backendId: 1 },
    async *iterate() {
      yield { text: 'hello' }
    },
    async await() {}
  })
  registerModel(modelId, {
    model: {
      addon: { async cancel() {} },
      async run() {
        return response()
      },
      async runStreaming() {
        return response()
      }
    } as unknown as AnyModel,
    path: '',
    config: {},
    modelType
  })
  t.teardown(() => unregisterModel(modelId))
}

async function lastFrame(stream: AsyncIterable<unknown>): Promise<unknown> {
  let last: unknown
  for await (const frame of stream) last = frame
  return last
}

const AUDIO = { type: 'base64' as const, value: Buffer.alloc(32).toString('base64') }
const emptyInput = () => (async function* () {})()

const PLUGINS = [
  { name: 'whisper', plugin: whisperPlugin, modelType: ModelType.whispercppTranscription },
  { name: 'parakeet', plugin: parakeetPlugin, modelType: ModelType.parakeetTranscription }
] as const

for (const { name, plugin, modelType } of PLUGINS) {
  test(`${name} unary handler feeds event.backend`, async (t) => {
    const modelId = `${name}-profiling-unary`
    register(t, modelId, modelType)
    const terminal = await lastFrame(
      plugin.handlers.transcribe.handler({
        type: 'transcribe',
        modelId,
        audioChunk: AUDIO
      }) as unknown as AsyncIterable<unknown>
    )
    const event = buildOperationEvent('transcribe', `${name}-p`, 0, 1, {}, terminal)
    t.alike(event?.backend, METAL)
  })

  test(`${name} duplex handler feeds event.backend`, async (t) => {
    const modelId = `${name}-profiling-duplex`
    register(t, modelId, modelType)
    const terminal = await lastFrame(
      plugin.handlers.transcribeStream.handler(
        { type: 'transcribeStream', modelId },
        emptyInput()
      ) as unknown as AsyncIterable<unknown>
    )
    const event = buildOperationEvent('transcribeStream', `${name}-p`, 0, 1, {}, terminal)
    t.alike(event?.backend, METAL)
  })
}
