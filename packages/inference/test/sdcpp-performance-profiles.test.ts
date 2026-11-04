import test from 'brittle'
import { sdcppConfigSchema } from '@/schemas/sdcpp-config'
import { loadModelOptionsBaseSchema, loadModelSrcRequestSchema } from '@/schemas/load-model'

test('diffusion profiles survive model options and wire validation with explicit overrides', (t) => {
  for (const performance_profile of ['auto', 'off', 'allow-small-changes'] as const) {
    const modelConfig = {
      mode: 'video' as const,
      performance_profile,
      performance_max_width: 512,
      performance_max_height: 320,
      performance_max_frames: 97,
      flash_attn: false,
      vae_conv_direct: true,
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
