import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import WorldStableDiffusion from '@qvac/diffusion-cpp/world'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg=='

let idCounter = 0
function makeId(prefix: string): string {
  idCounter++
  return `${prefix}-${idCounter}-${Date.now()}`
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sdcpp-world-op-test-'))
}

interface WorldModelStubs {
  load?: () => Promise<void>
  step?: (keys: unknown) => Promise<unknown>
  createScene?: (params: unknown) => Promise<unknown>
  cancel?: () => Promise<void>
}

async function withRegisteredWorldModel<T>(
  stubs: WorldModelStubs,
  info: { scenePath: string; t5Path?: string; vaePath?: string },
  body: (modelId: string) => Promise<T>
) {
  const [{ registerModel, unregisterModel }, { ModelType }, { markWorldModel }] = await Promise.all(
    [
      import('@/server/bare/registry/model-registry'),
      import('@/schemas'),
      import('@/server/bare/plugins/sdcpp-generation/ops/world')
    ]
  )
  const modelId = makeId('test-world')
  const fakeModel = Object.create(WorldStableDiffusion.prototype) as Record<string, unknown>
  fakeModel['load'] = stubs.load ?? async function () {}
  fakeModel['step'] = stubs.step
  fakeModel['createScene'] = stubs.createScene
  fakeModel['cancel'] = stubs.cancel ?? async function () {}
  markWorldModel(fakeModel as unknown as WorldStableDiffusion, info)

  try {
    registerModel(modelId, {
      model: fakeModel as never,
      path: '/tmp/abot-world-dit.gguf',
      config: {},
      modelType: ModelType.sdcppGeneration
    } as never)
    return await body(modelId)
  } finally {
    unregisterModel(modelId)
  }
}

test('world step op: loads on demand, forwards keys, and emits frame/progress/terminal chunks', async function (t) {
  const { worldStep } = await import('@/server/bare/plugins/sdcpp-generation/ops/world')

  const dir = makeTmpDir()
  const scenePath = path.join(dir, 'scene.safetensors')
  fs.writeFileSync(scenePath, 'stub')

  let loadCalls = 0
  let observedKeys: unknown
  await withRegisteredWorldModel(
    {
      load: async function () {
        loadCalls++
      },
      step: async function (keys: unknown) {
        observedKeys = keys
        return {
          stats: {
            stepMs: 1780,
            totalSteps: 1,
            totalFrames: 12,
            frames: 12,
            width: 832,
            height: 480
          },
          iterate: async function* () {
            yield new Uint8Array([137, 80, 78, 71])
            yield new Uint8Array([137, 80, 78, 71])
            yield JSON.stringify({ step: 1, frames: 12, elapsed_ms: 1780 })
          }
        }
      }
    },
    { scenePath },
    async (modelId) => {
      const chunks = []
      for await (const chunk of worldStep({ modelId, keys: ['W', 'L'] })) {
        chunks.push(chunk)
      }

      t.is(loadCalls, 1, 'the op ensures the (deferred) session load')
      t.alike(observedKeys, ['W', 'L'], 'keys forwarded verbatim')

      t.is(chunks[0]?.type, 'worldStep')
      t.is(chunks[0]?.outputIndex, 0)
      t.is(chunks[1]?.outputIndex, 1)
      t.alike(chunks[2], { type: 'worldStep', step: 1, frames: 12, elapsedMs: 1780 })
      t.is(chunks[3]?.done, true)
      t.alike(chunks[3]?.stats, {
        stepMs: 1780,
        totalSteps: 1,
        totalFrames: 12,
        frames: 12,
        width: 832,
        height: 480
      })
    }
  )

  fs.rmSync(dir, { recursive: true, force: true })
})

test('world step op: rejects with a structured error while the scene pack is absent', async function (t) {
  const [{ worldStep }, { PluginRequestValidationFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/ops/world'),
    import('@/utils/errors-server')
  ])

  const dir = makeTmpDir()
  const scenePath = path.join(dir, 'never-created.safetensors')

  await withRegisteredWorldModel(
    {
      step: async function () {
        t.fail('step must not be reached without a scene pack')
        return {}
      }
    },
    { scenePath },
    async (modelId) => {
      try {
        for await (const chunk of worldStep({ modelId })) {
          void chunk
        }
        t.fail('expected PluginRequestValidationFailedError')
      } catch (err) {
        t.ok(err instanceof PluginRequestValidationFailedError)
      }
    }
  )

  fs.rmSync(dir, { recursive: true, force: true })
})

test('world scene op: prefixes the prompt, writes only to the load-time path, and reports stats', async function (t) {
  const { worldCreateScene } = await import('@/server/bare/plugins/sdcpp-generation/ops/world')

  const dir = makeTmpDir()
  const scenePath = path.join(dir, 'scene.safetensors')

  let observed: Record<string, unknown> | undefined
  await withRegisteredWorldModel(
    {
      createScene: async function (params: unknown) {
        observed = params as Record<string, unknown>
        return {
          stats: { sceneCreateMs: 2306, width: 832, height: 480 },
          iterate: async function* () {
            yield JSON.stringify({ scene: scenePath, elapsed_ms: 2306 })
          }
        }
      }
    },
    { scenePath, t5Path: '/cache/umt5.gguf', vaePath: '/cache/vae.gguf' },
    async (modelId) => {
      const chunks = []
      for await (const chunk of worldCreateScene({
        modelId,
        prompt: 'a navigable path',
        image: PNG_B64,
        width: 448,
        height: 256
      })) {
        chunks.push(chunk)
      }

      t.ok(observed, 'model.createScene was called')
      t.is(observed?.['prompt'], '| unknown | a navigable path', 'reference prefix applied')
      t.is(observed?.['output'], scenePath, 'pack written to the load-time path only')
      t.is(observed?.['t5'], '/cache/umt5.gguf')
      t.is(observed?.['vae'], '/cache/vae.gguf')
      t.is(observed?.['width'], 448)
      t.is(observed?.['height'], 256)
      t.ok(observed?.['image'] instanceof Uint8Array, 'image decoded to bytes')

      t.is(chunks.length, 1, 'scene creation emits a single terminal chunk')
      t.is(chunks[0]?.done, true)
      t.alike(chunks[0]?.stats, { sceneCreateMs: 2306, width: 832, height: 480 })
    }
  )

  fs.rmSync(dir, { recursive: true, force: true })
})

test('world scene op: rejects when the model was loaded without the scene encoders', async function (t) {
  const [{ worldCreateScene }, { PluginRequestValidationFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/ops/world'),
    import('@/utils/errors-server')
  ])

  await withRegisteredWorldModel(
    {
      createScene: async function () {
        t.fail('createScene must not be reached without encoders')
        return {}
      }
    },
    { scenePath: '/models/scene.safetensors' },
    async (modelId) => {
      try {
        for await (const chunk of worldCreateScene({
          modelId,
          prompt: 'p',
          image: PNG_B64
        })) {
          void chunk
        }
        t.fail('expected PluginRequestValidationFailedError')
      } catch (err) {
        t.ok(err instanceof PluginRequestValidationFailedError)
      }
    }
  )
})

test('world ops: refuse a non-world model with a structured error', async function (t) {
  const [
    { worldStep },
    { ModelOperationNotSupportedError },
    { registerModel, unregisterModel },
    { ModelType }
  ] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/ops/world'),
    import('@/utils/errors-server'),
    import('@/server/bare/registry/model-registry'),
    import('@/schemas')
  ])

  const modelId = makeId('test-not-world')
  registerModel(modelId, {
    model: { load: async function () {} } as never,
    path: '/tmp/sd_xl_base.safetensors',
    config: {},
    modelType: ModelType.sdcppGeneration
  } as never)

  try {
    for await (const chunk of worldStep({ modelId })) {
      void chunk
    }
    t.fail('expected ModelOperationNotSupportedError')
  } catch (err) {
    t.ok(err instanceof ModelOperationNotSupportedError)
  } finally {
    unregisterModel(modelId)
  }
})

test('deferred world load: eager load no-ops without the pack, loads once it exists', async function (t) {
  const { installDeferredWorldLoad, markWorldModel } =
    await import('@/server/bare/plugins/sdcpp-generation/ops/world')

  const dir = makeTmpDir()
  const scenePath = path.join(dir, 'scene.safetensors')

  let nativeLoads = 0
  const fakeModel = Object.create(WorldStableDiffusion.prototype) as Record<string, unknown>
  fakeModel['load'] = async function () {
    nativeLoads++
  }
  const model = fakeModel as unknown as WorldStableDiffusion
  markWorldModel(model, { scenePath })
  installDeferredWorldLoad(model)

  await model.load()
  t.is(nativeLoads, 0, 'eager load defers while the scene pack is absent')

  fs.writeFileSync(scenePath, 'stub')
  await model.load()
  t.is(nativeLoads, 1, 'load passes through once the pack exists')

  fs.rmSync(dir, { recursive: true, force: true })
})
