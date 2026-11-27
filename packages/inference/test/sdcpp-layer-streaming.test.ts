import test from 'brittle'
import { sdcppConfigSchema } from '@/schemas/sdcpp-config'
import { loadModelOptionsBaseSchema, loadModelSrcRequestSchema } from '@/schemas/load-model'

const controls = {
  backend: 'diffusion=vulkan0,te=cpu,vae=cpu',
  paramsBackend: 'diffusion=cpu',
  maxVram: -1,
  streamLayers: true
}

test('diffusion memory controls survive load options and wire validation', (t) => {
  for (const maxVram of [0, -1, -0.5, 2.5, '6', '0', '-1', 'cuda0=6,vulkan0=4']) {
    for (const streamLayers of [undefined, false, true]) {
      const modelConfig = { ...controls, maxVram, streamLayers }
      const input = {
        modelSrc: '/models/diffusion.gguf',
        modelType: 'sdcpp-generation',
        modelConfig
      }
      const options = loadModelOptionsBaseSchema.safeParse(input)
      t.ok(options.success)
      if (options.success) t.alike(options.data.modelConfig, { mode: 'diffusion', ...modelConfig })
      const wire = loadModelSrcRequestSchema.safeParse({ ...input, type: 'loadModel' })
      t.ok(wire.success)
      if (wire.success) t.alike(wire.data.modelConfig, { mode: 'diffusion', ...modelConfig })
    }
  }
  t.alike(sdcppConfigSchema.parse({}), { mode: 'diffusion' }, 'leave defaults to the addon')
  t.is(sdcppConfigSchema.parse({ paramsBackend: 'diffusion=disk' }).paramsBackend, 'diffusion=disk')
})

test('diffusion memory controls reject incorrect types', (t) => {
  for (const modelConfig of [
    { backend: 1 },
    { paramsBackend: false },
    { maxVram: true },
    { maxVram: Infinity },
    { maxVram: NaN },
    { streamLayers: 'true' }
  ]) {
    t.is(sdcppConfigSchema.safeParse(modelConfig).success, false)
  }
})

test('diffusion memory controls preserve addon-owned string parsing', (t) => {
  for (const [key, value] of [
    ['backend', ''],
    ['paramsBackend', 'diffusion=cpu,'],
    ['paramsBackend', ' '],
    ['paramsBackend', 'a=b=c'],
    ['maxVram', '1e3'],
    ['maxVram', 'six']
  ] as const) {
    t.is(
      sdcppConfigSchema.safeParse({ [key]: value }).success,
      true,
      `${key} accepts native syntax`
    )
  }
})

test('removed diffusion CPU options fail with migration guidance', (t) => {
  for (const [key, replacement] of Object.entries({
    control_net_cpu: "modelConfig.backend: 'controlnet=cpu'",
    clip_on_cpu: "modelConfig.paramsBackend: 'te=cpu'",
    vae_on_cpu: "modelConfig.paramsBackend: 'vae=cpu'"
  })) {
    for (const value of [true, false, 0, 'false', '0']) {
      const modelConfig = { [key]: value }
      for (const result of [
        sdcppConfigSchema.safeParse(modelConfig),
        sdcppConfigSchema.partial().safeParse(modelConfig),
        loadModelOptionsBaseSchema.safeParse({
          modelSrc: '/models/diffusion.gguf',
          modelType: 'sdcpp-generation',
          modelConfig
        }),
        loadModelSrcRequestSchema.safeParse({
          type: 'loadModel',
          modelSrc: '/models/diffusion.gguf',
          modelType: 'sdcpp-generation',
          modelConfig
        })
      ]) {
        t.is(result.success, false)
        if (!result.success) {
          t.ok(
            result.error.message.includes(
              value === true ? replacement : 'Remove it; no replacement is needed when it is false.'
            )
          )
        }
      }
    }
  }
})

for (const mode of ['diffusion', 'video'] as const) {
  test(`diffusion memory controls reach the ${mode} addon after companion resolution`, async (t) => {
    const { diffusionPlugin } = await import('@/plugins/builtin/sdcpp-generation/plugin')
    for (const paramsBackend of ['diffusion=cpu', 'diffusion=disk']) {
      const memory = { ...controls, paramsBackend }
      const resolved = await diffusionPlugin.resolveConfig!(
        sdcppConfigSchema.parse({
          mode,
          ...memory,
          t5XxlModelSrc: '/models/t5.gguf',
          vaeModelSrc: '/models/vae.gguf'
        }),
        {
          resolveModelPath: async (src) => String(src),
          modelSrc: '/models/diffusion.gguf',
          modelType: 'sdcpp-generation'
        }
      )
      const result = diffusionPlugin.createModel({
        modelId: `streaming-${mode}-${paramsBackend}`,
        modelPath: '/models/diffusion.gguf',
        modelConfig: resolved.config,
        artifacts: resolved.artifacts!
      })
      const config = (result.model as unknown as { _config: Record<string, unknown> })._config
      for (const [key, nativeKey] of [
        ['backend', 'backend'],
        ['paramsBackend', 'params_backend'],
        ['maxVram', 'max_vram'],
        ['streamLayers', 'stream_layers']
      ] as const) {
        t.is(config[nativeKey], memory[key], `${nativeKey} reaches the addon`)
      }
    }
  })
}

test('diffusion config preserves existing unknown-key handling', (t) => {
  const modelConfig = { ...controls, unknown_option: true }
  t.alike(sdcppConfigSchema.parse(modelConfig), { mode: 'diffusion', ...controls })
  const input = {
    modelSrc: '/models/diffusion.gguf',
    modelType: 'sdcpp-generation',
    modelConfig
  }
  const wire = loadModelSrcRequestSchema.parse({ ...input, type: 'loadModel' })
  t.alike(wire.modelConfig, { mode: 'diffusion', ...controls })
  t.is(
    loadModelOptionsBaseSchema.safeParse(input).success,
    false,
    'public load options stay strict'
  )
})
