import test from 'brittle'
import { diffusionPlugin } from '@/plugins/builtin/sdcpp-generation/plugin'
import { loadModelOptionsBaseSchema } from '@/schemas'
import { ModelLoadFailedError } from '@/errors'

const config = {
  mode: 'video' as const,
  llmModelSrc: '/models/encoder.gguf',
  vaeModelSrc: '/models/video.safetensors',
  audioVaeModelSrc: '/models/audio.safetensors',
  backend: 'cuda0',
  params_backend: 'cpu',
  max_vram: 'cuda0=6,vulkan0=2',
  stream_layers: false
}

test('H3 plugin: public load config resolves four files and preserves native controls', async (t) => {
  const parsed = loadModelOptionsBaseSchema.parse({
    modelType: 'sdcpp-generation',
    modelSrc: '/models/model.gguf',
    modelConfig: config
  })
  t.alike(parsed.modelConfig, config)
  const resolved = await diffusionPlugin.resolveConfig!(config, {
    resolveModelPath: async (src) => String(src),
    modelSrc: '/models/model.gguf',
    modelType: 'sdcpp-generation'
  })
  t.alike(resolved.artifacts, {
    llmModelPath: '/models/encoder.gguf',
    vaeModelPath: '/models/video.safetensors',
    audioVaeModelPath: '/models/audio.safetensors'
  })
  t.alike(resolved.config, {
    mode: 'video',
    backend: 'cuda0',
    params_backend: 'cpu',
    max_vram: 'cuda0=6,vulkan0=2',
    stream_layers: false
  })
  const { model } = diffusionPlugin.createModel({
    modelId: 'h3-test',
    modelPath: '/models/model.gguf',
    modelConfig: resolved.config,
    artifacts: resolved.artifacts
  })
  const debug = model as {
    _files?: Record<string, string>
    _config?: Record<string, string | boolean>
  }
  t.alike(debug._files, {
    model: '/models/model.gguf',
    llm: '/models/encoder.gguf',
    vae: '/models/video.safetensors',
    audioVae: '/models/audio.safetensors'
  })
  t.is(debug._config?.['backend'], 'cuda0')
  t.is(debug._config?.['params_backend'], 'cpu')
  t.is(debug._config?.['max_vram'], 'cuda0=6,vulkan0=2')
  t.is(debug._config?.['stream_layers'], false)
})

test('H3 plugin: rejects missing and conflicting companions before resolution', async (t) => {
  for (const override of [
    { llmModelSrc: undefined },
    { vaeModelSrc: undefined },
    { audioVaeModelSrc: undefined },
    { t5XxlModelSrc: '/models/t5.gguf' },
    { highNoiseDiffusionModelSrc: '/models/expert.gguf' },
    { clipVisionModelSrc: '/models/clip.gguf' },
    { clipLModelSrc: '/models/clip-l.safetensors' },
    { clipGModelSrc: '/models/clip-g.safetensors' },
    { mode: 'diffusion' as const }
  ]) {
    let calls = 0
    await t.exception(
      async () =>
        diffusionPlugin.resolveConfig!(
          { ...config, ...override },
          {
            resolveModelPath: async (src) => {
              calls++
              return String(src)
            },
            modelSrc: '/models/model.gguf',
            modelType: 'sdcpp-generation'
          }
        ),
      ModelLoadFailedError as new () => Error
    )
    t.is(calls, 0)
  }
})

test('H3 plugin: constructor rejects incomplete and conflicting artifacts', (t) => {
  for (const override of [
    { llmModelPath: '' },
    { audioVaeModelPath: '' },
    { vaeModelPath: '' },
    { t5XxlModelPath: '/models/t5.gguf' },
    { highNoiseDiffusionModelPath: '/models/expert.gguf' },
    { clipVisionModelPath: '/models/clip.gguf' },
    { clipLModelPath: '/models/clip-l.safetensors' },
    { clipGModelPath: '/models/clip-g.safetensors' }
  ]) {
    t.exception(
      () =>
        diffusionPlugin.createModel({
          modelId: 'h3-invalid',
          modelPath: '/models/model.gguf',
          modelConfig: { mode: 'video' },
          artifacts: {
            llmModelPath: '/models/encoder.gguf',
            vaeModelPath: '/models/video.safetensors',
            audioVaeModelPath: '/models/audio.safetensors',
            ...override
          }
        }),
      ModelLoadFailedError as new () => Error
    )
  }
})

test('H3 plugin: a Wan config carrying a stray llmModelSrc still loads as Wan', async (t) => {
  const wan = {
    mode: 'video' as const,
    t5XxlModelSrc: '/models/t5.gguf',
    vaeModelSrc: '/models/video.safetensors',
    llmModelSrc: '/models/encoder.gguf'
  }
  const resolved = await diffusionPlugin.resolveConfig!(wan, {
    resolveModelPath: async (src) => String(src),
    modelSrc: '/models/model.gguf',
    modelType: 'sdcpp-generation'
  })
  const { model } = diffusionPlugin.createModel({
    modelId: 'wan-stray-llm',
    modelPath: '/models/model.gguf',
    modelConfig: resolved.config,
    artifacts: resolved.artifacts
  })
  const debug = model as { _files?: Record<string, string> }
  t.alike(debug._files, {
    model: '/models/model.gguf',
    vae: '/models/video.safetensors',
    t5Xxl: '/models/t5.gguf'
  })
})
