import test from 'brittle'

const resolveCtx = {
  resolveModelPath: async (src: unknown) => `/cache/${String(src)}`,
  modelSrc: 'registry://hf/abot-world-dit.gguf',
  modelType: 'sdcpp-generation'
}

const WORLD_BASE = {
  mode: 'world' as const,
  taehvModelSrc: 'registry://hf/taew2_2_f16.gguf',
  t5XxlModelSrc: 'registry://hf/umt5-xxl-enc-q8_0.gguf',
  vaeModelSrc: 'registry://hf/wan2.2_vae_f16.gguf'
}

test('sdcpp plugin resolveConfig: world resolves taehv + scene and strips *Src', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const resolved = await diffusionPlugin.resolveConfig!(
    { ...WORLD_BASE, sceneSrc: '/worlds/forest.safetensors' },
    resolveCtx
  )

  t.alike(resolved.artifacts, {
    t5XxlModelPath: '/cache/registry://hf/umt5-xxl-enc-q8_0.gguf',
    vaeModelPath: '/cache/registry://hf/wan2.2_vae_f16.gguf',
    taehvModelPath: '/cache/registry://hf/taew2_2_f16.gguf',
    seedScenePath: '/cache//worlds/forest.safetensors'
  })
  t.is('taehvModelSrc' in resolved.config, false, 'taehvModelSrc does not leak to the addon config')
  t.is('sceneSrc' in resolved.config, false, 'sceneSrc does not leak to the addon config')
})

test('sdcpp plugin resolveConfig: world may walk a pre-built pack without encoders', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const resolved = await diffusionPlugin.resolveConfig!(
    {
      mode: 'world',
      taehvModelSrc: 'registry://hf/taew2_2_f16.gguf',
      sceneSrc: '/worlds/forest.safetensors'
    },
    resolveCtx
  )

  t.alike(resolved.artifacts, {
    taehvModelPath: '/cache/registry://hf/taew2_2_f16.gguf',
    seedScenePath: '/cache//worlds/forest.safetensors'
  })
})

test('sdcpp plugin resolveConfig: world-only fields are rejected in other modes', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  await t.exception(
    diffusionPlugin.resolveConfig!(
      { mode: 'diffusion', taehvModelSrc: 'registry://hf/taew2_2_f16.gguf' },
      resolveCtx
    ),
    /taehvModelSrc is ABot-World only/,
    'taehvModelSrc outside world mode'
  )

  await t.exception(
    diffusionPlugin.resolveConfig!(
      { mode: 'video', sceneSrc: '/worlds/forest.safetensors' },
      resolveCtx
    ),
    /sceneSrc is ABot-World only/,
    'sceneSrc outside world mode'
  )

  await t.exception(
    diffusionPlugin.resolveConfig!({ mode: 'diffusion', world: { seed: 1 } }, resolveCtx),
    /world is ABot-World only/,
    'world block outside world mode'
  )
})

test('sdcpp plugin resolveConfig: world without taehv is rejected', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  await t.exception(
    diffusionPlugin.resolveConfig!(
      { mode: 'world', sceneSrc: '/worlds/forest.safetensors' },
      resolveCtx
    ),
    /taehvModelSrc is required in world mode/
  )
})

test('sdcpp plugin resolveConfig: world that can neither walk nor build is rejected', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  // No sceneSrc to walk, and no encoders to build one with.
  await t.exception(
    diffusionPlugin.resolveConfig!(
      { mode: 'world', taehvModelSrc: 'registry://hf/taew2_2_f16.gguf' },
      resolveCtx
    ),
    /needs either modelConfig\.sceneSrc/
  )

  // Half the encoder pair is still not enough to build one.
  await t.exception(
    diffusionPlugin.resolveConfig!(
      {
        mode: 'world',
        taehvModelSrc: 'registry://hf/taew2_2_f16.gguf',
        t5XxlModelSrc: 'registry://hf/umt5-xxl-enc-q8_0.gguf'
      },
      resolveCtx
    ),
    /needs either modelConfig\.sceneSrc/
  )
})

test('sdcpp plugin resolveConfig: world drops the upscaler block', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const resolved = await diffusionPlugin.resolveConfig!(
    { ...WORLD_BASE, upscaler: { tile_size: 128 } },
    resolveCtx
  )

  t.is('upscaler' in resolved.config, false, 'ESRGAN does not apply to a walk session')
})

test('sdcpp plugin createModel: world session defers activation when there is no scene', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const result = diffusionPlugin.createModel({
    modelId: 'world-deferred-test',
    modelPath: '/cache/abot-world-dit.gguf',
    modelConfig: { mode: 'world', world: { kvCache: true } },
    artifacts: {
      taehvModelPath: '/cache/taew2_2_f16.gguf',
      t5XxlModelPath: '/cache/umt5-xxl-enc-q8_0.gguf',
      vaeModelPath: '/cache/wan2.2_vae_f16.gguf'
    }
  })

  t.ok(typeof result.model.load === 'function', 'satisfies the plugin model contract')
  t.ok(typeof result.model.unload === 'function', 'exposes unload')

  // With no scene pack on disk, load() must return without touching the native
  // binding. If it tried to activate, the require('./binding') would fail here.
  await t.execution(result.model.load(false), 'load() defers activation instead of throwing')
})

test('sdcpp plugin createModel: world scene path is derived from a hash, not the modelId', async (t) => {
  const { worldScenePath } = await import('@/server/bare/plugins/sdcpp-generation/ops/world')

  const hostile = worldScenePath('../../etc/passwd')

  t.absent(hostile.includes('..'), 'a traversal-shaped modelId cannot steer the write')
  t.ok(hostile.includes('world-scenes'), 'scene packs stay in their own cache directory')
  t.ok(hostile.endsWith('.safetensors'), 'keeps the pack extension')
  t.is(
    worldScenePath('stable-id'),
    worldScenePath('stable-id'),
    'the same model always maps to the same pack, so createScene writes where load reads'
  )
})

test('world session: a failed generation leaves the previous world in place', async (t) => {
  const fs = await import('bare-fs')
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const result = diffusionPlugin.createModel({
    modelId: 'world-rollback-test',
    modelPath: '/cache/abot-world-dit.gguf',
    modelConfig: { mode: 'world' },
    artifacts: { taehvModelPath: '/cache/taew2_2_f16.gguf' }
  })
  const session = result.model as unknown as {
    scenePath: string
    stagingScenePath: string
    commitStagedScene(): Promise<void>
    discardStagedScene(): Promise<void>
    unload(): Promise<void>
  }

  // Staging must sit beside the pack: rename is only atomic within a filesystem.
  t.is(
    session.stagingScenePath.slice(0, session.scenePath.lastIndexOf('/')),
    session.scenePath.slice(0, session.scenePath.lastIndexOf('/')),
    'staging file is a sibling of the pack it replaces'
  )
  t.not(session.stagingScenePath, session.scenePath, 'generation never writes over the live pack')

  fs.writeFileSync(session.scenePath, 'the world the caller already had')
  fs.writeFileSync(session.stagingScenePath, 'a generation that failed halfway')

  await session.discardStagedScene()

  t.absent(fs.existsSync(session.stagingScenePath), 'the failed generation is dropped')
  t.is(
    fs.readFileSync(session.scenePath, 'utf8'),
    'the world the caller already had',
    'the previous world survives a failed replacement'
  )

  fs.writeFileSync(session.stagingScenePath, 'a generation that succeeded')
  await session.commitStagedScene()

  t.is(
    fs.readFileSync(session.scenePath, 'utf8'),
    'a generation that succeeded',
    'a successful generation takes over'
  )
  t.absent(fs.existsSync(session.stagingScenePath), 'staging does not linger after commit')

  await session.unload()
  t.absent(
    fs.existsSync(session.scenePath),
    'unload removes the managed pack rather than leaking it'
  )
})

test('sdcpp plugin createModel: world without taehv artifact throws ModelLoadFailedError', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')
  const { ModelLoadFailedError } = await import('@/utils/errors-server')

  try {
    diffusionPlugin.createModel({
      modelId: 'world-no-taehv',
      modelPath: '/cache/abot-world-dit.gguf',
      modelConfig: { mode: 'world' },
      artifacts: {}
    })
    t.fail('expected createModel to throw')
  } catch (error) {
    t.ok(error instanceof ModelLoadFailedError, 'throws the structured load error')
  }
})
