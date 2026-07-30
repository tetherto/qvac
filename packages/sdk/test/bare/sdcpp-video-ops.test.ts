import test from 'brittle'
import { VideoStableDiffusion } from '@qvac/diffusion-cpp'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg=='
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAA='

let idCounter = 0
function makeId(prefix: string): string {
  idCounter++
  return `${prefix}-${idCounter}-${Date.now()}`
}

async function withRegisteredVideoModel<T>(
  runImpl: (params: unknown) => Promise<unknown>,
  body: (modelId: string) => Promise<T>,
  cancelImpl: () => Promise<void> = async function () {},
  isLtx = false
) {
  const [{ registerModel, unregisterModel }, { ModelType }, { markLtxVideoModel }] =
    await Promise.all([
      import('@/server/bare/registry/model-registry'),
      import('@/schemas'),
      import('@/server/bare/plugins/sdcpp-generation/ops/video')
    ])
  const modelId = makeId('test-video')
  const fakeModel = Object.create(VideoStableDiffusion.prototype) as Record<string, unknown>
  fakeModel['load'] = async function () {}
  fakeModel['run'] = runImpl
  fakeModel['cancel'] = cancelImpl
  if (isLtx) markLtxVideoModel(fakeModel as unknown as VideoStableDiffusion)

  try {
    registerModel(modelId, {
      model: fakeModel as never,
      path: '/tmp/video-model.safetensors',
      config: {},
      modelType: ModelType.sdcppGeneration
    } as never)
    return await body(modelId)
  } finally {
    unregisterModel(modelId)
  }
}

test('video op: decodes base64 inputs, forwards mode, and emits stream responses', async function (t) {
  const { video: videoOp } = await import('@/server/bare/plugins/sdcpp-generation/ops/video')
  let observed: Record<string, unknown> | undefined

  await withRegisteredVideoModel(
    async function (params: unknown) {
      observed = params as Record<string, unknown>
      return {
        stats: {
          generationMs: 900,
          totalVideos: 1,
          totalVideoFrames: 5,
          videoFrames: 5,
          fps: 16
        },
        iterate: async function* () {
          yield JSON.stringify({ step: 2, total: 5, elapsed_ms: 250 })
          yield new Uint8Array([82, 73, 70, 70])
        }
      }
    },
    async (modelId) => {
      const chunks = []
      for await (const chunk of videoOp({
        modelId,
        mode: 'txt2vid',
        prompt: 'a running fox',
        control_frames: [PNG_B64, JPEG_B64],
        video_frames: 5,
        fps: 16
      })) {
        chunks.push(chunk)
      }

      t.ok(observed, 'model.run was called')
      t.is(observed?.['mode'], 'txt2vid')
      t.ok(Array.isArray(observed?.['control_frames']))
      t.is((observed?.['control_frames'] as Uint8Array[]).length, 2)

      t.alike(chunks[0], {
        type: 'videoStream',
        step: 2,
        totalSteps: 5,
        elapsedMs: 250
      })
      t.is(chunks[1]?.type, 'videoStream')
      t.is(chunks[1]?.outputIndex, 0)
      t.is(chunks[2]?.done, true)
      t.alike(chunks[2]?.stats, {
        generationMs: 900,
        totalVideos: 1,
        totalVideoFrames: 5,
        videoFrames: 5,
        fps: 16
      })
    }
  )
})

test('video op: maps addon numeric hasAudio to a boolean in final stats', async function (t) {
  const { video: videoOp } = await import('@/server/bare/plugins/sdcpp-generation/ops/video')

  await withRegisteredVideoModel(
    async function () {
      return {
        // Addon reports hasAudio as a 1/0 flag; the op must surface a boolean.
        stats: {
          generationMs: 1200,
          totalVideos: 1,
          videoFrames: 121,
          fps: 24,
          hasAudio: 1,
          audioSampleRate: 48000
        },
        iterate: async function* () {
          yield new Uint8Array([82, 73, 70, 70])
        }
      }
    },
    async (modelId) => {
      const chunks = []
      for await (const chunk of videoOp({
        modelId,
        mode: 'txt2vid',
        prompt: 'a jazz band with synced audio',
        video_frames: 121
      })) {
        chunks.push(chunk)
      }

      const finalChunk = chunks[chunks.length - 1]
      t.is(finalChunk?.done, true)
      t.is(finalChunk?.stats?.hasAudio, true, 'numeric 1 → boolean true')
      t.is(finalChunk?.stats?.audioSampleRate, 48000)
    }
  )
})

test('video op: silent video maps hasAudio 0 to false', async function (t) {
  const { video: videoOp } = await import('@/server/bare/plugins/sdcpp-generation/ops/video')

  await withRegisteredVideoModel(
    async function () {
      return {
        stats: {
          generationMs: 1200,
          totalVideos: 1,
          videoFrames: 121,
          fps: 24,
          hasAudio: 0,
          audioSampleRate: 0
        },
        iterate: async function* () {
          yield new Uint8Array([82, 73, 70, 70])
        }
      }
    },
    async (modelId) => {
      const chunks = []
      for await (const chunk of videoOp({
        modelId,
        mode: 'txt2vid',
        prompt: 'a silent clip',
        video_frames: 121
      })) {
        chunks.push(chunk)
      }

      const finalChunk = chunks[chunks.length - 1]
      t.is(finalChunk?.stats?.hasAudio, false, 'numeric 0 → boolean false')
    }
  )
})

test('video op: forwards img2vid init_image and strength to model.run', async function (t) {
  const { video: videoOp } = await import('@/server/bare/plugins/sdcpp-generation/ops/video')
  let observed: Record<string, unknown> | undefined

  await withRegisteredVideoModel(
    async function (params: unknown) {
      observed = params as Record<string, unknown>
      return {
        stats: { generationMs: 1, totalVideos: 1 },
        iterate: async function* () {
          yield new Uint8Array([82, 73, 70, 70])
        }
      }
    },
    async (modelId) => {
      for await (const _chunk of videoOp({
        modelId,
        mode: 'img2vid',
        prompt: 'gentle head turn',
        init_image: PNG_B64,
        strength: 0.9,
        video_frames: 5
      })) {
        // drain
      }

      t.ok(observed, 'model.run was called')
      t.is(observed?.['mode'], 'img2vid')
      t.is(observed?.['strength'], 0.9)
      t.ok(observed?.['init_image'] instanceof Uint8Array)
      t.is((observed?.['init_image'] as Uint8Array).length > 0, true)
    }
  )
})

test('video op: LTX-2 img2vid forwards init_image, strength, and temporal_tiling', async function (t) {
  const { video: videoOp } = await import('@/server/bare/plugins/sdcpp-generation/ops/video')
  let observed: Record<string, unknown> | undefined

  await withRegisteredVideoModel(
    async function (params: unknown) {
      observed = params as Record<string, unknown>
      return {
        stats: { generationMs: 1, totalVideos: 1 },
        iterate: async function* () {
          yield new Uint8Array([82, 73, 70, 70])
        }
      }
    },
    async (modelId) => {
      for await (const _chunk of videoOp({
        modelId,
        mode: 'img2vid',
        prompt: 'the subject slowly turns and smiles',
        init_image: PNG_B64,
        strength: 0.85,
        video_frames: 121,
        temporal_tiling: true
      })) {
        // drain
      }

      t.ok(observed, 'model.run was called')
      t.is(observed?.['mode'], 'img2vid')
      t.ok(observed?.['init_image'] instanceof Uint8Array)
      t.is(observed?.['strength'], 0.85)
      t.is(observed?.['temporal_tiling'], true)
    }
  )
})

test('video op: forwards temporal_tiling to model.run (LTX-2 video VAE knob)', async function (t) {
  const { video: videoOp } = await import('@/server/bare/plugins/sdcpp-generation/ops/video')
  let observed: Record<string, unknown> | undefined

  await withRegisteredVideoModel(
    async function (params: unknown) {
      observed = params as Record<string, unknown>
      return {
        stats: { generationMs: 1, totalVideos: 1 },
        iterate: async function* () {
          yield new Uint8Array([82, 73, 70, 70])
        }
      }
    },
    async (modelId) => {
      for await (const _chunk of videoOp({
        modelId,
        mode: 'txt2vid',
        prompt: 'a claymation cat playing jazz',
        video_frames: 121,
        temporal_tiling: true
      })) {
        // drain
      }

      t.ok(observed, 'model.run was called')
      t.is(observed?.['temporal_tiling'], true)
    }
  )
})

test('video op: rejects invalid LTX-2 dimensions and frame counts before generation', async function (t) {
  const [{ video: videoOp }, { PluginRequestValidationFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/ops/video'),
    import('@/utils/errors-server')
  ])
  let runCalls = 0

  await withRegisteredVideoModel(
    async function () {
      runCalls++
      return {
        iterate: async function* () {}
      }
    },
    async function (modelId) {
      await t.exception(
        async function () {
          await videoOp({
            modelId,
            mode: 'txt2vid',
            prompt: 'a fox',
            width: 528,
            height: 320,
            video_frames: 121
          }).next()
        },
        PluginRequestValidationFailedError as unknown as new () => Error
      )
      await t.exception(
        async function () {
          await videoOp({
            modelId,
            mode: 'txt2vid',
            prompt: 'a fox',
            width: 512,
            height: 496,
            video_frames: 121
          }).next()
        },
        PluginRequestValidationFailedError as unknown as new () => Error
      )
      await t.exception(
        async function () {
          await videoOp({
            modelId,
            mode: 'txt2vid',
            prompt: 'a fox',
            width: 512,
            height: 320,
            video_frames: 13
          }).next()
        },
        PluginRequestValidationFailedError as unknown as new () => Error
      )
      await t.exception(
        async function () {
          await videoOp({
            modelId,
            mode: 'txt2vid',
            prompt: 'a fox',
            width: 512,
            height: 320,
            video_frames: 265
          }).next()
        },
        PluginRequestValidationFailedError as unknown as new () => Error
      )
      t.is(runCalls, 0, 'invalid LTX-2 requests never reach model.run')
    },
    async function () {},
    true
  )
})

test('video op: broad cancel routes through registry and calls model.cancel', async function (t) {
  const [{ getRequestRegistry }, { video: videoOp }] = await Promise.all([
    import('@/server/bare/runtime'),
    import('@/server/bare/plugins/sdcpp-generation/ops/video')
  ])
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let cancelCalls = 0
  const requestId = makeId('video-req')

  await withRegisteredVideoModel(
    async function () {
      return {
        stats: {
          generationMs: 900,
          totalVideos: 1,
          totalVideoFrames: 5,
          videoFrames: 5,
          fps: 16
        },
        iterate: async function* () {
          await gate
          yield new Uint8Array([82, 73, 70, 70])
        }
      }
    },
    async (modelId) => {
      const gen = videoOp({
        modelId,
        requestId,
        mode: 'txt2vid',
        prompt: 'a running fox',
        video_frames: 5
      })
      const firstChunk = gen.next()
      await Promise.resolve()
      await Promise.resolve()

      const ctx = getRequestRegistry().get(requestId)
      t.ok(ctx !== null, 'video op registered the request')
      t.is(ctx?.kind, 'diffusion')
      t.is(ctx?.modelId, modelId)

      const cancelled = getRequestRegistry().cancel({ modelId })
      t.is(cancelled, 1, 'registry cancelled the video generation')
      t.is(cancelCalls, 1, 'registry abort forwarded to model.cancel()')

      release()
      const result = await firstChunk
      t.is(result.value?.done, true, 'cancelled stream still emits final marker')

      await gen.next()
      t.is(getRequestRegistry().get(requestId), null, 'registry slot was freed')
    },
    async function () {
      cancelCalls++
    }
  )
})
