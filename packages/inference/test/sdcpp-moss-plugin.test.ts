import test from 'brittle'
import { sdcppConfigSchema } from '@/schemas'

type DiffusionDebugModel = {
  _files?: Record<string, string | undefined>
}

const MOSS_MODEL =
  'https://huggingface.co/Comfy-Org/MOSS-Image/resolve/530a4c94f92c35ef6818b1b035a983fe9dcf5f54/diffusion_models/moss_image_sft_bf16.safetensors'
const MOSS_LLM =
  'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf'
const MOSS_VAE =
  'https://huggingface.co/Comfy-Org/MOSS-Image/resolve/530a4c94f92c35ef6818b1b035a983fe9dcf5f54/vae/flux2-vae_small.safetensors'
const MOSS_TOKENIZER =
  'https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT/resolve/f972bd4b4b9e3852133cc5da954d87bc32cd8fb9/tokenizer/tokenizer.json'

function resolveContext(onResolve?: () => void) {
  return {
    resolveModelPath: async (src: unknown) => {
      onResolve?.()
      return `/cache/${String(src).split('/').pop()}`
    },
    modelSrc: MOSS_MODEL,
    modelType: 'sdcpp-generation'
  }
}

test('sdcppConfigSchema: accepts the MOSS-Image companion layout', (t) => {
  const result = sdcppConfigSchema.safeParse({
    mode: 'diffusion',
    llmModelSrc: MOSS_LLM,
    vaeModelSrc: MOSS_VAE,
    tokenizerSrc: MOSS_TOKENIZER
  })

  t.is(result.success, true)
})

test('sdcpp plugin resolveConfig: resolves MOSS-Image companions and strips source fields', async (t) => {
  const { diffusionPlugin } = await import('@/plugins/builtin/sdcpp-generation/plugin')

  const resolved = await diffusionPlugin.resolveConfig!(
    {
      mode: 'diffusion',
      flash_attn: true,
      llmModelSrc: MOSS_LLM,
      vaeModelSrc: MOSS_VAE,
      tokenizerSrc: MOSS_TOKENIZER
    },
    resolveContext()
  )

  t.alike(resolved.artifacts, {
    llmModelPath: '/cache/Qwen3.5-9B-Q4_K_M.gguf',
    vaeModelPath: '/cache/flux2-vae_small.safetensors',
    tokenizerPath: '/cache/tokenizer.json'
  })
  t.is('tokenizerSrc' in resolved.config, false)
  t.is('llmModelSrc' in resolved.config, false)
  t.is('vaeModelSrc' in resolved.config, false)
  t.is(resolved.config.mode, 'diffusion')
  t.is(resolved.config.flash_attn, true)
})

test('sdcpp plugin resolveConfig: rejects the MOSS-Image tokenizer outside diffusion mode', async (t) => {
  const [{ diffusionPlugin }, { ModelLoadFailedError }] = await Promise.all([
    import('@/plugins/builtin/sdcpp-generation/plugin'),
    import('@/errors')
  ])

  for (const mode of ['video', 'upscale', 'world'] as const) {
    let resolveCalls = 0
    try {
      await diffusionPlugin.resolveConfig!(
        { mode, llmModelSrc: MOSS_LLM, vaeModelSrc: MOSS_VAE, tokenizerSrc: MOSS_TOKENIZER },
        resolveContext(() => resolveCalls++)
      )
      t.fail(`expected ModelLoadFailedError for tokenizerSrc in ${mode} mode`)
    } catch (error) {
      t.ok(error instanceof ModelLoadFailedError, `${mode} mode rejects tokenizerSrc`)
      t.ok(
        /tokenizerSrc is MOSS-Image diffusion only/.test((error as Error).message),
        `${mode}: the tokenizer guard is what rejects it`
      )
      t.is(resolveCalls, 0, `${mode}: guard fires before any companion download`)
    }
  }
})

test('sdcpp plugin resolveConfig: requires MOSS-Image LLM and VAE companions', async (t) => {
  const [{ diffusionPlugin }, { ModelLoadFailedError }] = await Promise.all([
    import('@/plugins/builtin/sdcpp-generation/plugin'),
    import('@/errors')
  ])

  for (const config of [
    { mode: 'diffusion' as const, vaeModelSrc: MOSS_VAE, tokenizerSrc: MOSS_TOKENIZER },
    { mode: 'diffusion' as const, llmModelSrc: MOSS_LLM, tokenizerSrc: MOSS_TOKENIZER }
  ]) {
    let resolveCalls = 0
    try {
      await diffusionPlugin.resolveConfig!(
        config,
        resolveContext(() => resolveCalls++)
      )
      t.fail('expected ModelLoadFailedError for an incomplete MOSS-Image layout')
    } catch (error) {
      t.ok(error instanceof ModelLoadFailedError)
      t.ok(
        /tokenizerSrc selects the MOSS-Image layout/.test((error as Error).message),
        'the MOSS-Image companion guard is what rejects it'
      )
      t.is(resolveCalls, 0, 'guard fires before any companion download')
    }
  }
})

test('sdcpp plugin createModel: wires the MOSS-Image tokenizer into the addon', async (t) => {
  const { diffusionPlugin } = await import('@/plugins/builtin/sdcpp-generation/plugin')

  const result = diffusionPlugin.createModel({
    modelId: 'moss-image-test',
    modelPath: '/tmp/moss_image_sft_bf16.safetensors',
    modelConfig: { mode: 'diffusion' },
    artifacts: {
      llmModelPath: '/tmp/Qwen3.5-9B-Q4_K_M.gguf',
      vaeModelPath: '/tmp/flux2-vae_small.safetensors',
      tokenizerPath: '/tmp/tokenizer.json'
    }
  })

  const files = (result.model as unknown as DiffusionDebugModel)._files ?? {}
  t.is(files['model'], '/tmp/moss_image_sft_bf16.safetensors')
  t.is(files['llm'], '/tmp/Qwen3.5-9B-Q4_K_M.gguf')
  t.is(files['vae'], '/tmp/flux2-vae_small.safetensors')
  t.is(files['tokenizer'], '/tmp/tokenizer.json')
})
