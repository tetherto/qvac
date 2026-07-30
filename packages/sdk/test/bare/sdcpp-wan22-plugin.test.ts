import test from 'brittle'

// `_files` is a private field on VideoStableDiffusion — narrow to a debug
// shape (mirrors sdcpp-ltx-plugin) so we can assert the plugin wired the right
// file slots without loading the native addon.
type VideoDebugModel = {
  _files?: Record<string, string | undefined>
}

test('sdcpp plugin resolveConfig: resolves the Wan 2.2 TI2V-5B layout and strips *Src', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const resolved = await diffusionPlugin.resolveConfig!(
    {
      mode: 'video',
      t5XxlModelSrc: 'registry://hf/umt5_xxl_fp16.safetensors',
      vaeModelSrc: 'registry://hf/wan2.2_vae.safetensors'
    },
    {
      resolveModelPath: async (src: unknown) => `/cache/${String(src)}`,
      modelSrc: 'registry://hf/Wan2_2-TI2V-5B-Turbo-Q5_K_S.gguf',
      modelType: 'sdcpp-generation'
    }
  )

  t.alike(resolved.artifacts, {
    t5XxlModelPath: '/cache/registry://hf/umt5_xxl_fp16.safetensors',
    vaeModelPath: '/cache/registry://hf/wan2.2_vae.safetensors'
  })
  t.is('t5XxlModelSrc' in resolved.config, false)
  t.is('vaeModelSrc' in resolved.config, false)
  t.is((resolved.config as { mode?: string }).mode, 'video')
})

test('sdcpp plugin resolveConfig: resolves the Wan 2.2 A14B layout and strips *Src', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const resolved = await diffusionPlugin.resolveConfig!(
    {
      mode: 'video',
      t5XxlModelSrc: 'registry://hf/umt5_xxl_fp16.safetensors',
      vaeModelSrc: 'registry://hf/wan2.2_vae.safetensors',
      highNoiseDiffusionModelSrc: 'registry://hf/wan2.2_t2v_high_noise.gguf'
    },
    {
      resolveModelPath: async (src: unknown) => `/cache/${String(src)}`,
      modelSrc: 'registry://hf/wan2.2_t2v_low_noise.gguf',
      modelType: 'sdcpp-generation'
    }
  )

  t.alike(resolved.artifacts, {
    t5XxlModelPath: '/cache/registry://hf/umt5_xxl_fp16.safetensors',
    vaeModelPath: '/cache/registry://hf/wan2.2_vae.safetensors',
    highNoiseDiffusionModelPath: '/cache/registry://hf/wan2.2_t2v_high_noise.gguf'
  })
  t.is('t5XxlModelSrc' in resolved.config, false)
  t.is('vaeModelSrc' in resolved.config, false)
  t.is('highNoiseDiffusionModelSrc' in resolved.config, false)
  t.is((resolved.config as { mode?: string }).mode, 'video')
})

test('sdcpp plugin resolveConfig: rejects a high-noise expert with the LTX-2 layout', async (t) => {
  const [{ diffusionPlugin }, { ModelLoadFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/plugin'),
    import('@/utils/errors-server')
  ])

  let resolveCalls = 0
  try {
    await diffusionPlugin.resolveConfig!(
      {
        mode: 'video',
        llmModelSrc: 'registry://hf/gemma-3-12b-it.gguf',
        vaeModelSrc: 'registry://hf/ltx_video_vae.safetensors',
        embeddingsConnectorsModelSrc: 'registry://hf/ltx_connectors.safetensors',
        highNoiseDiffusionModelSrc: 'registry://hf/wan2.2_high_noise.gguf'
      },
      {
        resolveModelPath: async (src: unknown) => {
          resolveCalls++
          return `/cache/${String(src)}`
        },
        modelSrc: 'registry://hf/ltx.gguf',
        modelType: 'sdcpp-generation'
      }
    )
    t.fail('expected ModelLoadFailedError for an LTX-2 layout with a Wan high-noise expert')
  } catch (err) {
    t.ok(err instanceof ModelLoadFailedError)
    t.is(resolveCalls, 0, 'guard fires before any companion download')
  }
})

test('sdcpp plugin resolveConfig: rejects a high-noise expert outside video mode', async (t) => {
  const [{ diffusionPlugin }, { ModelLoadFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/plugin'),
    import('@/utils/errors-server')
  ])

  // Only the video layout has a second-expert slot. 'upscale' additionally
  // returns early from resolveConfig, so the guard has to run ahead of it.
  for (const mode of ['diffusion', 'upscale'] as const) {
    let resolveCalls = 0
    try {
      await diffusionPlugin.resolveConfig!(
        {
          mode,
          highNoiseDiffusionModelSrc: 'registry://hf/wan2.2_high_noise.gguf'
        },
        {
          resolveModelPath: async (src: unknown) => {
            resolveCalls++
            return `/cache/${String(src)}`
          },
          modelSrc: 'registry://hf/sd_xl_base.safetensors',
          modelType: 'sdcpp-generation'
        }
      )
      t.fail(`expected ModelLoadFailedError for mode: '${mode}' with a high-noise expert`)
    } catch (err) {
      t.ok(err instanceof ModelLoadFailedError, `mode: '${mode}' is rejected`)
      t.is(resolveCalls, 0, `mode: '${mode}' never downloads the expert`)
    }
  }
})

test('sdcpp plugin createModel: Wan 2.2 TI2V-5B wires model + t5Xxl + vae only', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const result = diffusionPlugin.createModel({
    modelId: 'wan22-ti2v-test',
    modelPath: '/tmp/Wan2_2-TI2V-5B-Turbo-Q5_K_S.gguf',
    modelConfig: { mode: 'video' },
    artifacts: {
      t5XxlModelPath: '/tmp/umt5_xxl_fp16.safetensors',
      vaeModelPath: '/tmp/wan2.2_vae.safetensors'
    }
  })

  const files = (result.model as unknown as VideoDebugModel)._files ?? {}
  t.is(files['model'], '/tmp/Wan2_2-TI2V-5B-Turbo-Q5_K_S.gguf')
  t.is(files['t5Xxl'], '/tmp/umt5_xxl_fp16.safetensors')
  t.is(files['vae'], '/tmp/wan2.2_vae.safetensors')
  t.is(files['highNoiseDiffusionModel'], undefined, 'TI2V-5B is single-expert — no high-noise slot')
  // txt2vid-only: CLIP vision is a Wan img2vid companion.
  t.is(files['clipVision'], undefined)
  t.is(files['llm'], undefined, 'Wan layout must not set the LTX llm slot')
  t.is(files['embeddingsConnectors'], undefined)
})

test('sdcpp plugin createModel: Wan 2.2 A14B wires the high-noise expert slot', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const result = diffusionPlugin.createModel({
    modelId: 'wan22-a14b-test',
    modelPath: '/tmp/wan2.2_t2v_low_noise.gguf',
    modelConfig: { mode: 'video' },
    artifacts: {
      t5XxlModelPath: '/tmp/umt5_xxl_fp16.safetensors',
      vaeModelPath: '/tmp/wan2.2_vae.safetensors',
      highNoiseDiffusionModelPath: '/tmp/wan2.2_t2v_high_noise.gguf'
    }
  })

  const files = (result.model as unknown as VideoDebugModel)._files ?? {}
  t.is(files['model'], '/tmp/wan2.2_t2v_low_noise.gguf')
  t.is(files['highNoiseDiffusionModel'], '/tmp/wan2.2_t2v_high_noise.gguf')
})

test('sdcpp plugin createModel: Wan 2.2 video without t5Xxl throws ModelLoadFailedError', async (t) => {
  const [{ diffusionPlugin }, { ModelLoadFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/plugin'),
    import('@/utils/errors-server')
  ])

  try {
    diffusionPlugin.createModel({
      modelId: 'wan22-no-encoder',
      modelPath: '/tmp/Wan2_2-TI2V-5B-Turbo-Q5_K_S.gguf',
      modelConfig: { mode: 'video' },
      artifacts: { vaeModelPath: '/tmp/wan2.2_vae.safetensors' }
    })
    t.fail('expected ModelLoadFailedError for Wan video without t5XxlModelSrc')
  } catch (err) {
    t.ok(err instanceof ModelLoadFailedError)
  }
})
