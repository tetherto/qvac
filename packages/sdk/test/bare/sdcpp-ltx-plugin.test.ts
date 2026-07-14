import test from 'brittle'

// `_files` is a private field on VideoStableDiffusion — narrow to a debug
// shape (mirrors the tts-resolve-config createModel tests) so we can assert
// the plugin wired the right file slots without loading the native addon.
type VideoDebugModel = {
  _files?: Record<string, string | undefined>
}

test('sdcpp plugin resolveConfig: resolves LTX-2 companions to artifacts and strips *Src', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const resolved = await diffusionPlugin.resolveConfig!(
    {
      mode: 'video',
      llmModelSrc: 'registry://hf/gemma-3-12b-it.gguf',
      vaeModelSrc: 'registry://hf/ltx_video_vae.safetensors',
      audioVaeModelSrc: 'registry://hf/ltx_audio_vae.safetensors',
      embeddingsConnectorsModelSrc: 'registry://hf/ltx_connectors.safetensors'
    },
    {
      resolveModelPath: async (src: unknown) => `/cache/${String(src)}`,
      modelSrc: 'registry://hf/ltx.gguf',
      modelType: 'sdcpp-generation'
    }
  )

  t.alike(resolved.artifacts, {
    llmModelPath: '/cache/registry://hf/gemma-3-12b-it.gguf',
    vaeModelPath: '/cache/registry://hf/ltx_video_vae.safetensors',
    audioVaeModelPath: '/cache/registry://hf/ltx_audio_vae.safetensors',
    embeddingsConnectorsModelPath: '/cache/registry://hf/ltx_connectors.safetensors'
  })
  // *Src fields must not leak into the runtime config forwarded to the addon.
  t.is('llmModelSrc' in resolved.config, false)
  t.is('vaeModelSrc' in resolved.config, false)
  t.is('audioVaeModelSrc' in resolved.config, false)
  t.is('embeddingsConnectorsModelSrc' in resolved.config, false)
  t.is((resolved.config as { mode?: string }).mode, 'video')
})

test('sdcpp plugin resolveConfig: rejects audioVaeModelSrc without LTX layout (Wan video)', async (t) => {
  const [{ diffusionPlugin }, { ModelLoadFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/plugin'),
    import('@/utils/errors-server')
  ])

  let resolveCalls = 0
  try {
    await diffusionPlugin.resolveConfig!(
      {
        mode: 'video',
        t5XxlModelSrc: 'registry://hf/umt5.safetensors',
        vaeModelSrc: 'registry://hf/wan_vae.safetensors',
        // audio VAE is LTX-only; no embeddingsConnectors → Wan layout.
        audioVaeModelSrc: 'registry://hf/ltx_audio_vae.safetensors'
      },
      {
        resolveModelPath: async (src: unknown) => {
          resolveCalls++
          return `/cache/${String(src)}`
        },
        modelSrc: 'registry://hf/wan.gguf',
        modelType: 'sdcpp-generation'
      }
    )
    t.fail(
      'expected ModelLoadFailedError for audioVaeModelSrc without embeddingsConnectorsModelSrc'
    )
  } catch (err) {
    t.ok(err instanceof ModelLoadFailedError)
    t.is(resolveCalls, 0, 'guard fires before any companion download')
  }
})

test('sdcpp plugin resolveConfig: rejects embeddingsConnectorsModelSrc outside video mode', async (t) => {
  const [{ diffusionPlugin }, { ModelLoadFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/plugin'),
    import('@/utils/errors-server')
  ])

  try {
    await diffusionPlugin.resolveConfig!(
      {
        mode: 'diffusion',
        vaeModelSrc: 'registry://hf/vae.safetensors',
        embeddingsConnectorsModelSrc: 'registry://hf/ltx_connectors.safetensors'
      },
      {
        resolveModelPath: async (src: unknown) => `/cache/${String(src)}`,
        modelSrc: 'registry://hf/model.gguf',
        modelType: 'sdcpp-generation'
      }
    )
    t.fail('expected ModelLoadFailedError for embeddingsConnectorsModelSrc in diffusion mode')
  } catch (err) {
    t.ok(err instanceof ModelLoadFailedError)
  }
})

test('sdcpp plugin createModel: LTX-2 video layout wires llm + vae + connectors (+ audio)', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const result = diffusionPlugin.createModel({
    modelId: 'ltx-test',
    modelPath: '/tmp/ltx.gguf',
    modelConfig: { mode: 'video' },
    artifacts: {
      llmModelPath: '/tmp/gemma.gguf',
      vaeModelPath: '/tmp/ltx_video_vae.safetensors',
      audioVaeModelPath: '/tmp/ltx_audio_vae.safetensors',
      embeddingsConnectorsModelPath: '/tmp/ltx_connectors.safetensors'
    }
  })

  const files = (result.model as unknown as VideoDebugModel)._files ?? {}
  t.is(files['model'], '/tmp/ltx.gguf')
  t.is(files['llm'], '/tmp/gemma.gguf')
  t.is(files['vae'], '/tmp/ltx_video_vae.safetensors')
  t.is(files['audioVae'], '/tmp/ltx_audio_vae.safetensors')
  t.is(files['embeddingsConnectors'], '/tmp/ltx_connectors.safetensors')
  t.is(files['t5Xxl'], undefined, 'LTX layout must not set the Wan t5Xxl slot')
  // LTX-2 img2vid conditions through the video VAE, so no CLIP vision slot is
  // wired even when the model is loaded for both txt2vid and img2vid.
  t.is(files['clipVision'], undefined, 'LTX layout must not set the Wan clipVision slot')
})

test('sdcpp plugin createModel: LTX-2 audio VAE is optional (silent video)', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const result = diffusionPlugin.createModel({
    modelId: 'ltx-silent',
    modelPath: '/tmp/ltx.gguf',
    modelConfig: { mode: 'video' },
    artifacts: {
      llmModelPath: '/tmp/gemma.gguf',
      vaeModelPath: '/tmp/ltx_video_vae.safetensors',
      embeddingsConnectorsModelPath: '/tmp/ltx_connectors.safetensors'
    }
  })

  const files = (result.model as unknown as VideoDebugModel)._files ?? {}
  t.is(files['embeddingsConnectors'], '/tmp/ltx_connectors.safetensors')
  t.is(files['audioVae'], undefined, 'audio VAE omitted → no audio slot')
})

test('sdcpp plugin createModel: Wan video layout unchanged (t5Xxl, no LTX slots)', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const result = diffusionPlugin.createModel({
    modelId: 'wan-test',
    modelPath: '/tmp/wan.gguf',
    modelConfig: { mode: 'video' },
    artifacts: {
      t5XxlModelPath: '/tmp/umt5.safetensors',
      vaeModelPath: '/tmp/wan_vae.safetensors'
    }
  })

  const files = (result.model as unknown as VideoDebugModel)._files ?? {}
  t.is(files['t5Xxl'], '/tmp/umt5.safetensors')
  t.is(files['vae'], '/tmp/wan_vae.safetensors')
  t.is(files['llm'], undefined)
  t.is(files['embeddingsConnectors'], undefined)
})

test('sdcpp plugin createModel: LTX-2 without llm throws ModelLoadFailedError', async (t) => {
  const [{ diffusionPlugin }, { ModelLoadFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/plugin'),
    import('@/utils/errors-server')
  ])

  try {
    diffusionPlugin.createModel({
      modelId: 'ltx-no-llm',
      modelPath: '/tmp/ltx.gguf',
      modelConfig: { mode: 'video' },
      artifacts: {
        vaeModelPath: '/tmp/ltx_video_vae.safetensors',
        embeddingsConnectorsModelPath: '/tmp/ltx_connectors.safetensors'
      }
    })
    t.fail('expected ModelLoadFailedError for LTX-2 without llmModelSrc')
  } catch (err) {
    t.ok(err instanceof ModelLoadFailedError)
  }
})

test('sdcpp plugin createModel: video mode without vae throws ModelLoadFailedError', async (t) => {
  const [{ diffusionPlugin }, { ModelLoadFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/plugin'),
    import('@/utils/errors-server')
  ])

  try {
    diffusionPlugin.createModel({
      modelId: 'ltx-no-vae',
      modelPath: '/tmp/ltx.gguf',
      modelConfig: { mode: 'video' },
      artifacts: {
        llmModelPath: '/tmp/gemma.gguf',
        embeddingsConnectorsModelPath: '/tmp/ltx_connectors.safetensors'
      }
    })
    t.fail('expected ModelLoadFailedError for video mode without vaeModelSrc')
  } catch (err) {
    t.ok(err instanceof ModelLoadFailedError)
  }
})
