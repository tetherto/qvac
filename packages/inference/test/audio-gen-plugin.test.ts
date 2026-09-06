import test from 'brittle'
import { AudioGen } from '@qvac/audiogen-ggml'
import type { AudiogenOutputChunk, AudiogenStats } from '@qvac/audiogen-ggml'
import { audioGenStream } from '@/plugins/builtin/audiogen-ggml/ops/audio-gen-stream'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/index'
import { ModelType } from '@/schemas/index'
import { readBackendDiagnostics } from '@/profiling/backend-diagnostics'
import { ModelOperationNotSupportedError } from '@/errors/index'

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

test('audioGen plugin operation rejects a model from another plugin', async (t) => {
  const modelId = 'audio-gen-operation-wrong-model'
  registerModel(modelId, {
    model: {} as AnyModel,
    path: '',
    config: {},
    modelType: ModelType.llamacppCompletion
  })
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const stream = audioGenStream({
    type: 'audioGenStream',
    requestId: 'audio-gen-request-wrong-model',
    modelId,
    caption: 'ambient electronic music'
  })

  try {
    await stream.next()
    t.fail('expected a model/plugin mismatch error')
  } catch (error) {
    t.ok(error instanceof ModelOperationNotSupportedError)
    t.is((error as ModelOperationNotSupportedError).operation, 'audioGenStream')
  }
  t.is(getRequestRegistry().get('audio-gen-request-wrong-model'), null)
})

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
  t.is(frames[1]?.bitsPerSample, 16)
  t.ok(frames[1]?.data !== undefined)
  t.is(frames[2]?.type, 'audioGenStream')
  t.is(frames[2]?.done, true)
  t.is(frames[2]?.stopReason, 'completed')
  t.alike(frames[2]?.stats, {
    audioDurationMs: 10,
    totalTimeMs: 5,
    realTimeFactor: 0.5,
    backendDevice: 1,
    backendId: 1
  })
  t.alike(frames[2]?.diagnostics, {
    selectedBackend: 'metal',
    selectedDevice: 'gpu',
    graphicsApi: 'metal'
  })
  t.alike(
    readBackendDiagnostics(frames[2]),
    frames[2]?.diagnostics,
    'symbol and schema field carry the same diagnostics'
  )
  t.is(getRequestRegistry().get(requestId), null)
})

test('audioGen plugin operation yields indeterminate LM progress', async (t) => {
  const modelId = 'audio-gen-operation-indeterminate-progress'
  const model = createModel(createResponse([{ progress: { stage: 'lm', step: 1, total: -1 } }], {}))
  registerAudioGenModel(modelId, model)
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const stream = audioGenStream({
    type: 'audioGenStream',
    requestId: 'audio-gen-request-indeterminate-progress',
    modelId,
    caption: 'ambient electronic music'
  })

  t.alike((await stream.next()).value, {
    type: 'audioGenStream',
    progress: { stage: 'lm', step: 1, total: -1 },
    done: false
  })
  t.is((await stream.next()).value?.done, true)
})

test('audioGen terminal diagnostics report a GPU fallback reason, or omit it', async (t) => {
  const cases = [
    { code: 2, reason: 'no-devices' },
    { code: 3, reason: 'init-failed' }
  ]

  for (const { code, reason } of cases) {
    const modelId = `audio-gen-fallback-${reason}`
    const model = createModel(
      createResponse([], { backendDevice: 0, backendId: 0, gpuFallbackReason: code })
    )
    registerAudioGenModel(modelId, model)
    t.teardown(() => {
      unregisterModel(modelId)
    })

    const frames = []
    for await (const frame of audioGenStream({
      type: 'audioGenStream',
      requestId: `audio-gen-request-fallback-${reason}`,
      modelId,
      caption: 'ambient electronic music'
    })) {
      frames.push(frame)
    }

    t.alike(
      frames[0]?.diagnostics,
      {
        selectedBackend: 'cpu',
        selectedDevice: 'cpu',
        fallback: { requestedDevice: 'gpu', reason }
      },
      `${reason} reaches the caller`
    )
    t.alike(
      readBackendDiagnostics(frames[0]),
      frames[0]?.diagnostics,
      `${reason} also reaches the symbol`
    )
    t.absent('gpuFallbackReason' in (frames[0]?.stats ?? {}), 'the raw code stays off the wire')
  }

  // none / not-requested describe a run that never lost a GPU, and an
  // unrecognised code must not become a guessed reason.
  for (const code of [0, 1, 99]) {
    const modelId = `audio-gen-fallback-omitted-${code}`
    const model = createModel(
      createResponse([], { backendDevice: 0, backendId: 0, gpuFallbackReason: code })
    )
    registerAudioGenModel(modelId, model)
    t.teardown(() => {
      unregisterModel(modelId)
    })

    const frames = []
    for await (const frame of audioGenStream({
      type: 'audioGenStream',
      requestId: `audio-gen-request-fallback-omitted-${code}`,
      modelId,
      caption: 'ambient electronic music'
    })) {
      frames.push(frame)
    }

    t.alike(
      frames[0]?.diagnostics,
      { selectedBackend: 'cpu', selectedDevice: 'cpu' },
      `code ${code} carries no fallback`
    )
  }
})

test('audioGen terminal diagnostics name the CPU backend and skip an unnamed GPU backend', async (t) => {
  const cpuModelId = 'audio-gen-diagnostics-cpu'
  const cpuModel = createModel(createResponse([], { backendDevice: 0, backendId: 0 }))
  registerAudioGenModel(cpuModelId, cpuModel)
  t.teardown(() => {
    unregisterModel(cpuModelId)
  })

  const cpuFrames = []
  for await (const frame of audioGenStream({
    type: 'audioGenStream',
    requestId: 'audio-gen-request-diagnostics-cpu',
    modelId: cpuModelId,
    caption: 'ambient electronic music'
  })) {
    cpuFrames.push(frame)
  }

  t.alike(cpuFrames[0]?.diagnostics, {
    selectedBackend: 'cpu',
    selectedDevice: 'cpu'
  })

  const unknownModelId = 'audio-gen-diagnostics-unknown'
  const unknownModel = createModel(createResponse([], { backendDevice: 1, backendId: 7 }))
  registerAudioGenModel(unknownModelId, unknownModel)
  t.teardown(() => {
    unregisterModel(unknownModelId)
  })

  const unknownFrames = []
  for await (const frame of audioGenStream({
    type: 'audioGenStream',
    requestId: 'audio-gen-request-diagnostics-unknown',
    modelId: unknownModelId,
    caption: 'ambient electronic music'
  })) {
    unknownFrames.push(frame)
  }

  t.is(unknownFrames[0]?.diagnostics, undefined)
  t.is(readBackendDiagnostics(unknownFrames[0]), undefined)

  const noStatsModelId = 'audio-gen-diagnostics-no-device'
  const noStatsModel = createModel(createResponse([], {}))
  registerAudioGenModel(noStatsModelId, noStatsModel)
  t.teardown(() => {
    unregisterModel(noStatsModelId)
  })

  const noStatsFrames = []
  for await (const frame of audioGenStream({
    type: 'audioGenStream',
    requestId: 'audio-gen-request-diagnostics-no-device',
    modelId: noStatsModelId,
    caption: 'ambient electronic music'
  })) {
    noStatsFrames.push(frame)
  }

  t.is(noStatsFrames[0]?.diagnostics, undefined)
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
  const response = createResponse(
    [
      { progress: { stage: 'dit', step: 1, total: 2 } },
      { progress: { stage: 'dit', step: 2, total: 2 } }
    ],
    {}
  )
  let runCalls = 0
  let cancelCalls = 0
  const model = createModel(response, function onCancel() {
    cancelCalls++
  })
  model.run = async function () {
    runCalls++
    return response
  }
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
  t.is(runCalls, 1)

  const queuedStream = audioGenStream({
    type: 'audioGenStream',
    requestId: queuedRequestId,
    modelId,
    caption: 'queued generation'
  })
  const queuedFirstPromise = queuedStream.next()
  await new Promise<void>((resolve) => setTimeout(resolve, 5))

  t.is(getRequestRegistry().cancel({ requestId: queuedRequestId }), 1)
  const queuedFirst = await queuedFirstPromise
  t.alike(queuedFirst.value, {
    type: 'audioGenStream',
    done: true,
    stopReason: 'cancelled'
  })
  t.is(cancelCalls, 0, 'queued cancellation did not touch the active addon job')
  t.is(runCalls, 1, 'queued-and-cancelled request never invoked the addon')

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

test('queued AudioGen run waits for active native cancellation to settle', async (t) => {
  const modelId = 'audio-gen-operation-deferred-cancel'
  const activeRequestId = 'audio-gen-request-deferred-active'
  const queuedRequestId = 'audio-gen-request-deferred-queued'
  const response = createResponse(
    [
      { progress: { stage: 'dit', step: 1, total: 2 } },
      { progress: { stage: 'dit', step: 2, total: 2 } }
    ],
    {}
  )
  let resolveCancel: (() => void) | undefined
  const cancelGate = new Promise<void>((resolve) => {
    resolveCancel = resolve
  })
  let runCalls = 0
  let cancelCalls = 0
  const model = createModel(response)
  model.run = async function () {
    runCalls++
    return response
  }
  model.cancel = async function () {
    cancelCalls++
    await cancelGate
  }
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
  t.is((await activeStream.next()).value?.progress?.step, 1)
  t.is(runCalls, 1)

  const queuedStream = audioGenStream({
    type: 'audioGenStream',
    requestId: queuedRequestId,
    modelId,
    caption: 'queued generation'
  })
  let queuedResolved = false
  const queuedFirstPromise = queuedStream.next().then((result) => {
    queuedResolved = true
    return result
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))

  t.is(getRequestRegistry().cancel({ requestId: activeRequestId }), 1)
  t.is((await activeStream.next()).value?.stopReason, 'cancelled')
  const activeDonePromise = activeStream.next()
  await new Promise<void>((resolve) => setTimeout(resolve, 5))

  t.is(cancelCalls, 1)
  t.is(runCalls, 1, 'queued run has not touched the addon')
  t.is(queuedResolved, false, 'queued run still waits for native cancellation')

  resolveCancel?.()
  t.ok((await activeDonePromise).done)

  const queuedFirst = await queuedFirstPromise
  t.is(queuedFirst.value?.progress?.step, 1)
  t.is(runCalls, 2, 'queued run starts after native cancellation settles')
  t.is((await queuedStream.next()).value?.progress?.step, 2)
  t.is((await queuedStream.next()).value?.stopReason, 'completed')
  t.ok((await queuedStream.next()).done)
  t.is(getRequestRegistry().get(activeRequestId), null)
  t.is(getRequestRegistry().get(queuedRequestId), null)
})
