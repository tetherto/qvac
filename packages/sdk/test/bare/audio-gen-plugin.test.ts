import test from 'brittle'
import { AudioGen } from '@qvac/audiogen-ggml'
import type { AudiogenOutputChunk, AudiogenStats } from '@qvac/audiogen-ggml'
import { audioGenStream } from '@/server/bare/plugins/audiogen-ggml/ops/audio-gen-stream'
import {
  registerModel,
  unregisterModel,
  type AnyModel
} from '@/server/bare/registry/model-registry'
import { getRequestRegistry } from '@/server/bare/runtime'
import { ModelType } from '@/schemas'

type AudioGenResponse = Awaited<ReturnType<AudioGen['run']>>

function createResponse(chunks: AudiogenOutputChunk[], stats: AudiogenStats): AudioGenResponse {
  return {
    async *iterate() {
      for (const chunk of chunks) yield chunk
    },
    async await() {
      return stats
    }
  } as unknown as AudioGenResponse
}

function createModel(response: AudioGenResponse, onCancel?: () => void) {
  const model = new AudioGen({
    files: {
      textEncModel: 'text-encoder.gguf',
      lmModel: 'lm.gguf',
      ditModel: 'dit.gguf',
      vaeModel: 'vae.gguf'
    }
  })
  model.run = async function () {
    return response
  }
  model.cancel = async function () {
    onCancel?.()
  }
  return model
}

function registerAudioGenModel(modelId: string, model: AudioGen) {
  registerModel(modelId, {
    model: model as unknown as AnyModel,
    path: '',
    config: {},
    modelType: ModelType.audiogenGgml
  })
}

test('audioGen plugin operation streams progress, PCM, and terminal stats', async (t) => {
  const modelId = 'audio-gen-operation-success'
  const requestId = 'audio-gen-request-success'
  const model = createModel(
    createResponse(
      [
        { progress: { stage: 'dit', step: 1, total: 2 } },
        {
          outputArray: new Int16Array([1, -1]),
          sampleRate: 44100,
          channels: 2
        }
      ],
      {
        audioDurationMs: 10,
        totalTimeMs: 5,
        realTimeFactor: 0.5,
        backendDevice: 1,
        backendId: 1
      }
    )
  )
  registerAudioGenModel(modelId, model)
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const frames = []
  for await (const frame of audioGenStream({
    type: 'audioGenStream',
    requestId,
    modelId,
    caption: 'ambient electronic music'
  })) {
    frames.push(frame)
  }

  t.alike(frames[0], {
    type: 'audioGenStream',
    progress: { stage: 'dit', step: 1, total: 2 },
    done: false
  })
  t.is(frames[1]?.sampleRate, 44100)
  t.is(frames[1]?.channels, 2)
  t.ok(frames[1]?.data !== undefined)
  t.alike(frames[2], {
    type: 'audioGenStream',
    done: true,
    stopReason: 'completed',
    stats: {
      audioDurationMs: 10,
      totalTimeMs: 5,
      realTimeFactor: 0.5,
      backendDevice: 1,
      backendId: 1
    }
  })
  t.is(getRequestRegistry().get(requestId), null)
})

test('audioGen plugin operation hard-cancels and frees its registry entry', async (t) => {
  const modelId = 'audio-gen-operation-cancel'
  const requestId = 'audio-gen-request-cancel'
  let cancelCalls = 0
  const model = createModel(
    createResponse(
      [
        { progress: { stage: 'dit', step: 1, total: 2 } },
        { progress: { stage: 'dit', step: 2, total: 2 } }
      ],
      {}
    ),
    function onCancel() {
      cancelCalls++
    }
  )
  registerAudioGenModel(modelId, model)
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const stream = audioGenStream({
    type: 'audioGenStream',
    requestId,
    modelId,
    caption: 'ambient electronic music'
  })
  const first = await stream.next()
  t.is(first.value?.progress?.step, 1)
  t.is(getRequestRegistry().cancel({ requestId }), 1)

  const cancelled = await stream.next()
  t.alike(cancelled.value, {
    type: 'audioGenStream',
    done: true,
    stopReason: 'cancelled'
  })
  t.is(cancelCalls, 1)

  const completed = await stream.next()
  t.ok(completed.done)
  t.is(getRequestRegistry().get(requestId), null)
})

test('cancelling a queued AudioGen request does not cancel the active run', async (t) => {
  const modelId = 'audio-gen-operation-queued-cancel'
  const activeRequestId = 'audio-gen-request-active'
  const queuedRequestId = 'audio-gen-request-queued'
  let cancelCalls = 0
  const model = createModel(
    createResponse(
      [
        { progress: { stage: 'dit', step: 1, total: 2 } },
        { progress: { stage: 'dit', step: 2, total: 2 } }
      ],
      {}
    ),
    function onCancel() {
      cancelCalls++
    }
  )
  registerAudioGenModel(modelId, model)
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const activeStream = audioGenStream({
    type: 'audioGenStream',
    requestId: activeRequestId,
    modelId,
    caption: 'active generation'
  })
  const activeFirst = await activeStream.next()
  t.is(activeFirst.value?.progress?.step, 1)

  const queuedStream = audioGenStream({
    type: 'audioGenStream',
    requestId: queuedRequestId,
    modelId,
    caption: 'queued generation'
  })
  const queuedFirstPromise = queuedStream.next()
  await new Promise((resolve) => setTimeout(resolve, 5))

  t.is(getRequestRegistry().cancel({ requestId: queuedRequestId }), 1)
  const queuedFirst = await queuedFirstPromise
  t.alike(queuedFirst.value, {
    type: 'audioGenStream',
    done: true,
    stopReason: 'cancelled'
  })
  t.is(cancelCalls, 0, 'queued cancellation did not touch the active addon job')

  const activeSecond = await activeStream.next()
  t.is(activeSecond.value?.progress?.step, 2, 'active generation continues')
  const activeTerminal = await activeStream.next()
  t.is(activeTerminal.value?.stopReason, 'completed')
  t.is(cancelCalls, 0)

  t.ok((await queuedStream.next()).done)
  t.ok((await activeStream.next()).done)
  t.is(getRequestRegistry().get(activeRequestId), null)
  t.is(getRequestRegistry().get(queuedRequestId), null)
})
