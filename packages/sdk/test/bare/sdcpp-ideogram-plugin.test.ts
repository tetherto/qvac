import test from 'brittle'
import { sdcppConfigSchema } from '@/schemas'

type DiffusionDebugModel = {
  _files?: Record<string, string | undefined>
}

const IDEOGRAM_MODEL =
  'https://huggingface.co/leejet/ideogram-4-GGUF/resolve/main/ideogram4-Q4_0.gguf'
const IDEOGRAM_UNCOND_MODEL =
  'https://huggingface.co/leejet/ideogram-4-GGUF/resolve/main/ideogram4_uncond-Q4_0.gguf'
const IDEOGRAM_LLM =
  'https://huggingface.co/unsloth/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3-VL-8B-Instruct-Q4_K_M.gguf'
const IDEOGRAM_VAE =
  'https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors'

test('sdcppConfigSchema: accepts the Ideogram 4 companion layout', (t) => {
  const result = sdcppConfigSchema.safeParse({
    mode: 'diffusion',
    device: 'gpu',
    diffusion_fa: true,
    offload_to_cpu: true,
    llmModelSrc: IDEOGRAM_LLM,
    vaeModelSrc: IDEOGRAM_VAE,
    uncondModelSrc: IDEOGRAM_UNCOND_MODEL
  })

  t.is(result.success, true)
})

test('sdcpp plugin resolveConfig: resolves Ideogram companions and strips source fields', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const resolved = await diffusionPlugin.resolveConfig!(
    {
      mode: 'diffusion',
      diffusion_fa: true,
      offload_to_cpu: true,
      llmModelSrc: IDEOGRAM_LLM,
      vaeModelSrc: IDEOGRAM_VAE,
      uncondModelSrc: IDEOGRAM_UNCOND_MODEL
    },
    {
      resolveModelPath: async (src: unknown) => `/cache/${String(src).split('/').pop()}`,
      modelSrc: IDEOGRAM_MODEL,
      modelType: 'sdcpp-generation'
    }
  )

  t.alike(resolved.artifacts, {
    llmModelPath: '/cache/Qwen3-VL-8B-Instruct-Q4_K_M.gguf',
    vaeModelPath: '/cache/flux2-vae.safetensors',
    uncondModelPath: '/cache/ideogram4_uncond-Q4_0.gguf'
  })
  t.is('llmModelSrc' in resolved.config, false)
  t.is('vaeModelSrc' in resolved.config, false)
  t.is('uncondModelSrc' in resolved.config, false)
  t.is(resolved.config.mode, 'diffusion')
  t.is(resolved.config.diffusion_fa, true)
  t.is(resolved.config.offload_to_cpu, true)
})

test('sdcpp plugin resolveConfig: rejects Ideogram unconditional model outside diffusion mode', async (t) => {
  const [{ diffusionPlugin }, { ModelLoadFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/plugin'),
    import('@/utils/errors-server')
  ])
  let resolveCalls = 0

  try {
    await diffusionPlugin.resolveConfig!(
      {
        mode: 'video',
        llmModelSrc: IDEOGRAM_LLM,
        vaeModelSrc: IDEOGRAM_VAE,
        uncondModelSrc: IDEOGRAM_UNCOND_MODEL
      },
      {
        resolveModelPath: async () => {
          resolveCalls++
          return '/cache/model'
        },
        modelSrc: IDEOGRAM_MODEL,
        modelType: 'sdcpp-generation'
      }
    )
    t.fail('expected ModelLoadFailedError for Ideogram unconditional model in video mode')
  } catch (error) {
    t.ok(error instanceof ModelLoadFailedError)
    t.is(resolveCalls, 0, 'guard fires before any companion download')
  }
})

test('sdcpp plugin resolveConfig: requires Ideogram LLM and VAE companions', async (t) => {
  const [{ diffusionPlugin }, { ModelLoadFailedError }] = await Promise.all([
    import('@/server/bare/plugins/sdcpp-generation/plugin'),
    import('@/utils/errors-server')
  ])

  for (const config of [
    {
      mode: 'diffusion' as const,
      vaeModelSrc: IDEOGRAM_VAE,
      uncondModelSrc: IDEOGRAM_UNCOND_MODEL
    },
    {
      mode: 'diffusion' as const,
      llmModelSrc: IDEOGRAM_LLM,
      uncondModelSrc: IDEOGRAM_UNCOND_MODEL
    }
  ]) {
    try {
      await diffusionPlugin.resolveConfig!(config, {
        resolveModelPath: async () => '/cache/model',
        modelSrc: IDEOGRAM_MODEL,
        modelType: 'sdcpp-generation'
      })
      t.fail('expected ModelLoadFailedError for an incomplete Ideogram layout')
    } catch (error) {
      t.ok(error instanceof ModelLoadFailedError)
    }
  }
})

test('sdcpp plugin createModel: wires Ideogram unconditional model into the addon', async (t) => {
  const { diffusionPlugin } = await import('@/server/bare/plugins/sdcpp-generation/plugin')

  const result = diffusionPlugin.createModel({
    modelId: 'ideogram-test',
    modelPath: '/tmp/ideogram4-Q4_0.gguf',
    modelConfig: {
      mode: 'diffusion',
      diffusion_fa: true,
      offload_to_cpu: true
    },
    artifacts: {
      llmModelPath: '/tmp/Qwen3-VL-8B-Instruct-Q4_K_M.gguf',
      vaeModelPath: '/tmp/flux2-vae.safetensors',
      uncondModelPath: '/tmp/ideogram4_uncond-Q4_0.gguf'
    }
  })

  const files = (result.model as unknown as DiffusionDebugModel)._files ?? {}
  t.is(files['model'], '/tmp/ideogram4-Q4_0.gguf')
  t.is(files['llm'], '/tmp/Qwen3-VL-8B-Instruct-Q4_K_M.gguf')
  t.is(files['vae'], '/tmp/flux2-vae.safetensors')
  t.is(files['uncondModel'], '/tmp/ideogram4_uncond-Q4_0.gguf')
})
