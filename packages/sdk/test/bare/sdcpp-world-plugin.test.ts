import test from 'brittle'

test('sdcpp plugin resolveConfig: resolves the ABot-World layout and strips *Src', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const resolved = await diffusionPlugin.resolveConfig!(
    {
      mode: 'world',
      taehvModelSrc: 'registry://s3/taew2_2_f16.gguf',
      t5XxlModelSrc: 'registry://s3/umt5-xxl-enc-q8_0.gguf',
      vaeModelSrc: 'registry://s3/wan2.2_vae_f16.gguf',
      world: { scenePack: '/models/scene.safetensors', kv_cache: true }
    },
    {
      resolveModelPath: async (src: unknown) => `/cache/${String(src)}`,
      modelSrc: 'registry://s3/abot-world-0-5b-lf-dit-q8_0.gguf',
      modelType: 'sdcpp-generation'
    }
  )

  t.alike(resolved.artifacts, {
    taehvModelPath: 'registry://s3/taew2_2_f16.gguf'.replace(/^/, '/cache/'),
    t5XxlModelPath: '/cache/registry://s3/umt5-xxl-enc-q8_0.gguf',
    vaeModelPath: '/cache/registry://s3/wan2.2_vae_f16.gguf'
  })
  t.is('taehvModelSrc' in resolved.config, false)
  t.is('t5XxlModelSrc' in resolved.config, false)
  t.is('vaeModelSrc' in resolved.config, false)
  const config = resolved.config as { mode?: string; world?: { scenePack?: string } }
  t.is(config.mode, 'world')
  t.is(config.world?.scenePack, '/models/scene.safetensors')
})

test('sdcpp plugin resolveConfig: rejects taehvModelSrc outside world mode', async (t) => {
  const [{ diffusionPlugin }, { ModelLoadFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/plugin'),
    import('@/utils/errors-server')
  ])

  for (const mode of ['diffusion', 'video', 'upscale'] as const) {
    let resolveCalls = 0
    try {
      await diffusionPlugin.resolveConfig!(
        {
          mode,
          taehvModelSrc: 'registry://s3/taew2_2_f16.gguf'
        },
        {
          resolveModelPath: async (src: unknown) => {
            resolveCalls++
            return `/cache/${String(src)}`
          },
          modelSrc: 'registry://s3/model.gguf',
          modelType: 'sdcpp-generation'
        }
      )
      t.fail(`expected ModelLoadFailedError for mode: '${mode}' with taehvModelSrc`)
    } catch (err) {
      t.ok(err instanceof ModelLoadFailedError, `mode '${mode}' rejects taehvModelSrc`)
      t.is(resolveCalls, 0, 'guard fires before any companion download')
    }
  }
})

test('sdcpp plugin resolveConfig: world mode requires taehvModelSrc and world.scenePack', async (t) => {
  const [{ diffusionPlugin }, { ModelLoadFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/plugin'),
    import('@/utils/errors-server')
  ])

  const ctx = {
    resolveModelPath: async (src: unknown) => `/cache/${String(src)}`,
    modelSrc: 'registry://s3/abot-world-0-5b-lf-dit-q8_0.gguf',
    modelType: 'sdcpp-generation'
  }

  try {
    await diffusionPlugin.resolveConfig!(
      { mode: 'world', world: { scenePack: '/models/scene.safetensors' } },
      ctx
    )
    t.fail('expected ModelLoadFailedError without taehvModelSrc')
  } catch (err) {
    t.ok(err instanceof ModelLoadFailedError, 'missing taehvModelSrc rejects')
  }

  try {
    await diffusionPlugin.resolveConfig!(
      { mode: 'world', taehvModelSrc: 'registry://s3/taew2_2_f16.gguf' },
      ctx
    )
    t.fail('expected ModelLoadFailedError without world.scenePack')
  } catch (err) {
    t.ok(err instanceof ModelLoadFailedError, 'missing world.scenePack rejects')
  }
})

test('sdcpp plugin resolveConfig: rejects the world block outside world mode', async (t) => {
  const [{ diffusionPlugin }, { ModelLoadFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/plugin'),
    import('@/utils/errors-server')
  ])

  try {
    await diffusionPlugin.resolveConfig!(
      { mode: 'diffusion', world: { scenePack: '/models/scene.safetensors' } },
      {
        resolveModelPath: async (src: unknown) => `/cache/${String(src)}`,
        modelSrc: 'registry://s3/sd_xl_base.safetensors',
        modelType: 'sdcpp-generation'
      }
    )
    t.fail('expected ModelLoadFailedError for a world block in diffusion mode')
  } catch (err) {
    t.ok(err instanceof ModelLoadFailedError)
  }
})
