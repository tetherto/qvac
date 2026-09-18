import test from 'brittle'
import Buffer from 'bare-buffer'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { bciPlugin } from '@/plugins/builtin/bci-whispercpp-transcription/plugin'
import { buildOperationEvent } from '@/profiling'
import {
  ModelType,
  type BciTranscribeResponse,
  type BciTranscribeStreamResponse
} from '@/schemas/index'

// These drive the real BCI handlers, so they prove the values leave the
// handler intact rather than only surviving a mapper in isolation.

function response(outputs: unknown[], stats?: Record<string, number>) {
  return {
    ...(stats && { stats }),
    async *iterate() {
      for (const output of outputs) yield output
    },
    async await() {}
  }
}

function register(
  t: { teardown(fn: () => void): void },
  modelId: string,
  model: Record<string, unknown>
) {
  registerModel(modelId, {
    model: { addon: { async cancel() {} }, ...model } as unknown as AnyModel,
    path: '',
    config: {},
    modelType: ModelType.bciWhispercppTranscription
  })
  t.teardown(() => unregisterModel(modelId))
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const frames: T[] = []
  for await (const frame of stream) frames.push(frame)
  return frames
}

const NEURAL = { type: 'base64' as const, value: Buffer.alloc(16).toString('base64') }

test('bci batch diagnostics reach the profiling event', async (t) => {
  // backendDevice 1 + backendId 1 (Metal) is a GPU verdict the mapper names.
  const modelId = 'bci-reach-diagnostics'
  register(t, modelId, {
    async transcribe() {
      return response([{ text: 'hello' }], { backendDevice: 1, backendId: 1 })
    }
  })

  const frames = await collect(
    bciPlugin.handlers.bciTranscribe.handler({
      type: 'bciTranscribe',
      modelId,
      neuralData: NEURAL
    }) as unknown as AsyncIterable<BciTranscribeResponse>
  )

  // The profiling wrapper hands a streaming handler's last chunk to
  // buildOperationEvent as `finalResponse`; replay exactly that.
  const terminal = frames.at(-1)
  const expected = { selectedBackend: 'metal', selectedDevice: 'gpu', graphicsApi: 'metal' }
  t.alike(terminal?.diagnostics, expected, 'the wire field is on the terminal frame')
  const event = buildOperationEvent('bciTranscribe', 'bci-profile', 0, 1, {}, terminal)
  t.alike(event?.backend, expected, 'the symbol reaches event.backend')
})

test('bci delta streaming segments keep windowStartTimestep', async (t) => {
  const modelId = 'bci-reach-window'
  register(t, modelId, {
    async transcribeStream() {
      return response([{ text: 'tail', start: 0.5, end: 1.5, windowStartTimestep: 1500 }])
    }
  })

  const frames = await collect(
    bciPlugin.handlers.bciTranscribeStream.handler(
      { type: 'bciTranscribeStream', modelId, metadata: true },
      (async function* () {})()
    ) as unknown as AsyncIterable<BciTranscribeStreamResponse>
  )

  const segment = frames.find((frame) => frame.segment)?.segment
  t.is(segment?.windowStartTimestep, 1500, 'the window origin leaves the handler')
})
