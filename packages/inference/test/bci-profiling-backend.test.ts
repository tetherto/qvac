import test from 'brittle'
import Buffer from 'bare-buffer'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { bciPlugin } from '@/plugins/builtin/bci-whispercpp-transcription/plugin'
import { buildOperationEvent } from '@/profiling'
import { readModelExecutionMs } from '@/profiling/model-execution'
import {
  ModelType,
  type BciTranscribeResponse,
  type BciTranscribeStreamResponse
} from '@/schemas/index'

// Drives the real BCI handlers and replays the last chunk the way the
// profiling wrapper does, so the timing and backend verdict are shown to
// reach the profiling layer rather than only being attached.

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
  const modelId = 'bci-profiling-diagnostics'
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

test('bci streaming terminal frame carries the model execution time', async (t) => {
  const modelId = 'bci-profiling-stream-timing'
  register(t, modelId, {
    async transcribeStream() {
      return response([{ text: 'tail' }])
    }
  })

  const frames = await collect(
    bciPlugin.handlers.bciTranscribeStream.handler(
      { type: 'bciTranscribeStream', modelId },
      (async function* () {})()
    ) as unknown as AsyncIterable<BciTranscribeStreamResponse>
  )

  const terminal = frames.at(-1)
  t.is(terminal?.done, true, 'the last frame is the terminal one')
  const ms = readModelExecutionMs(terminal)
  t.ok(typeof ms === 'number' && ms >= 0, 'the execution time is attached to the terminal frame')

  const event = buildOperationEvent('bciTranscribeStream', 'bci-stream-profile', 0, 1, {}, terminal)
  t.is(event?.gauges?.['modelExecutionTime'], ms, 'and it reaches the profiling event')
})

test('bci batch stats reach the profiling event as gauges', async (t) => {
  const modelId = 'bci-profiling-stats'
  register(t, modelId, {
    async transcribe() {
      return response([{ text: 'hello' }], {
        tokensPerSecond: 12,
        totalTokens: 7,
        totalWallMs: 34,
        processCalls: 3,
        whisperSampleMs: 5
      })
    }
  })

  const frames = await collect(
    bciPlugin.handlers.bciTranscribe.handler({
      type: 'bciTranscribe',
      modelId,
      neuralData: NEURAL
    }) as unknown as AsyncIterable<BciTranscribeResponse>
  )

  const event = buildOperationEvent('bciTranscribe', 'bci-stats-profile', 0, 1, {}, frames.at(-1))
  t.is(event?.gauges?.['tokensPerSecond'], 12, 'a shared counter is reported')
  t.is(event?.gauges?.['totalWallMs'], 34, 'a BCI-specific counter is reported')
  t.is(event?.gauges?.['whisperSampleMs'], 5, 'a whisper.cpp stage timing is reported')
  t.ok(typeof event?.gauges?.['modelExecutionTime'] === 'number', 'alongside the execution time')
})
