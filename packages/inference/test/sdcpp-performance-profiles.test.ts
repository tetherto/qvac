import test from 'brittle'
import { sdcppConfigSchema } from '@/schemas/sdcpp-config'
import { loadModelOptionsBaseSchema, loadModelSrcRequestSchema } from '@/schemas/load-model'
import { createDiffusionFitRequest } from '@/model-fit/request/engines/diffusion'

test('diffusion profiles survive model options and wire validation with explicit overrides', (t) => {
  for (const performance_profile of ['auto', 'off'] as const) {
    const modelConfig = {
      mode: 'video' as const,
      performance_profile,
      performance_max_width: 512,
      performance_max_height: 320,
      performance_max_frames: 97,
      flash_attn: false,
      vae_conv_direct: performance_profile === 'auto',
      tensor_type_rules: ''
    }
    const input = { modelType: 'sdcpp-generation', modelSrc: '/models/ltx.gguf', modelConfig }
    t.alike(loadModelOptionsBaseSchema.parse(input).modelConfig, modelConfig)
    t.alike(
      loadModelSrcRequestSchema.parse({ ...input, type: 'loadModel' }).modelConfig,
      modelConfig
    )
    t.alike(sdcppConfigSchema.partial().parse(modelConfig), modelConfig)
  }
  t.alike(sdcppConfigSchema.parse({}), { mode: 'diffusion' }, 'defaults remain addon-owned')
})

test('diffusion profiles reject unsupported modes and invalid output limits', (t) => {
  for (const config of [
    { performance_profile: 'fast' },
    { performance_profile: 'allow-small-changes' },
    { performance_profile: true },
    { performance_max_width: 0 },
    { performance_max_height: -1 },
    { performance_max_frames: 1.5 },
    { performance_max_frames: 2147483648 },
    { performance_max_frames: '97' },
    { vae_conv_direct: 'false' },
    { tensor_type_rules: false }
  ]) {
    t.is(sdcppConfigSchema.safeParse(config).success, false)
  }
})

test('bounded video fit requests assess the maximum declared output', (t) => {
  const bounds = {
    performance_max_width: 512,
    performance_max_height: 320,
    performance_max_frames: 97
  }
  for (const performance_profile of ['auto', 'off'] as const) {
    const config = sdcppConfigSchema.parse({
      mode: 'video',
      performance_profile,
      vae_tiling: true,
      ...bounds
    })
    const plan = createDiffusionFitRequest({ modelPath: '/models/ltx.gguf', modelConfig: config })
    t.ok(plan.supported)
    if (plan.supported && plan.probe.engine === 'diffusion-cpp') {
      t.alike(plan.probe.request.workload, {
        width: 512,
        height: 320,
        videoFrames: 97,
        vaeTiling: true
      })
      t.alike(plan.probe.request.config, { performance_profile, vae_tiling: true, ...bounds })
    }
  }
})

test('unbounded, partially bounded and image fit requests retain their defaults', (t) => {
  const limits = {
    performance_max_width: 512,
    performance_max_height: 320,
    performance_max_frames: 97
  }
  const partialLimits = Object.keys(limits).map((missing) =>
    Object.fromEntries(Object.entries(limits).filter(([key]) => key !== missing))
  )
  for (const bounds of [{}, ...partialLimits]) {
    const plan = createDiffusionFitRequest({
      modelPath: '/models/ltx.gguf',
      modelConfig: { mode: 'video', ...bounds }
    })
    t.ok(plan.supported)
    if (plan.supported && plan.probe.engine === 'diffusion-cpp') {
      t.alike(plan.probe.request.workload, { videoFrames: 33 })
    }
  }
  const plan = createDiffusionFitRequest({
    modelPath: '/models/flux.gguf',
    modelConfig: { mode: 'diffusion', ...limits }
  })
  t.ok(plan.supported)
  if (plan.supported && plan.probe.engine === 'diffusion-cpp') {
    t.alike(plan.probe.request.workload, {})
  }
})
