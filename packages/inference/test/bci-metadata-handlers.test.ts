import test from 'brittle'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { bciPlugin } from '@/plugins/builtin/bci-whispercpp-transcription/plugin'
import { ModelType, type BciTranscribeStreamResponse } from '@/schemas/index'

// Drives the real BCI streaming handler, so the segment fields are shown to
// leave the handler intact rather than only surviving the mapper in isolation.

function register(t: { teardown(fn: () => void): void }, modelId: string, outputs: unknown[]) {
  registerModel(modelId, {
    model: {
      addon: { async cancel() {} },
      async transcribeStream() {
        return {
          async *iterate() {
            for (const output of outputs) yield output
          },
          async await() {}
        }
      }
    } as unknown as AnyModel,
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

test('bci delta streaming segments keep windowStartTimestep', async (t) => {
  const modelId = 'bci-metadata-window'
  register(t, modelId, [{ text: 'tail', start: 0.5, end: 1.5, windowStartTimestep: 1500 }])

  const frames = await collect(
    bciPlugin.handlers.bciTranscribeStream.handler(
      { type: 'bciTranscribeStream', modelId, metadata: true },
      (async function* () {})()
    ) as unknown as AsyncIterable<BciTranscribeStreamResponse>
  )

  const segment = frames.find((frame) => frame.segment)?.segment
  t.is(segment?.windowStartTimestep, 1500, 'the window origin leaves the handler')
})
