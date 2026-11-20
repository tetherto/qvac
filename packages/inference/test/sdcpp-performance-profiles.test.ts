import test from 'brittle'
import type { DiffusionFitRequest } from '@qvac/diffusion-cpp'
import { sdcppConfigSchema, sdcppLoadConfigSchema } from '@/schemas/sdcpp-config'
import {
  loadBuiltinToRequestSchema,
  loadDiffusionModelRequestSchema,
  loadModelOptionsBaseSchema,
  loadModelSrcRequestSchema
} from '@/schemas/load-model'
import { ModelType } from '@/schemas/model-types'
import { MODEL_CONFIG_SCHEMAS } from '@/runtime/model-config-utils'
import { sdcppFitRequest } from '@/plugins/builtin/sdcpp-generation/fit'
import type { FitRequestPlan } from '@/schemas/plugin'

function requestOf(plan: FitRequestPlan) {
  return 'request' in plan ? (plan.request as DiffusionFitRequest) : undefined
}

function fitPlan(modelConfig: Record<string, unknown>) {
  return sdcppFitRequest({
    modelPath: '/models/model.gguf',
    modelConfig,
    artifacts: { t5XxlModelPath: '/models/umt5.gguf', vaeModelPath: '/models/wan-vae.safetensors' },
    isShardedModel: false
  })
}

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

test('partial output limits are rejected wherever a diffusion load is validated', (t) => {
  const limits = {
    performance_max_width: 512,
    performance_max_height: 320,
    performance_max_frames: 97
  }
  for (const missing of Object.keys(limits)) {
    const modelConfig = {
      mode: 'video' as const,
      ...Object.fromEntries(Object.entries(limits).filter(([key]) => key !== missing))
    }
    const input = { modelType: 'sdcpp-generation', modelSrc: '/models/ltx.gguf', modelConfig }
    const request = { ...input, type: 'loadModel' }
    // These report the missing limit; the loadModel unions reject it inside a union issue.
    for (const [name, result] of [
      ['load config', sdcppLoadConfigSchema.safeParse(modelConfig)],
      ['device defaults', MODEL_CONFIG_SCHEMAS[ModelType.sdcppGeneration]!.safeParse(modelConfig)],
      ['SDK client', loadBuiltinToRequestSchema.safeParse(input)],
      ['diffusion request', loadDiffusionModelRequestSchema.safeParse(request)]
    ] as const) {
      t.is(result.success, false, `${name} rejects a config without ${missing}`)
      t.ok(
        result.error?.issues.some((issue) => issue.path.at(-1) === missing),
        `${name} points at ${missing}`
      )
    }
    t.is(loadModelOptionsBaseSchema.safeParse(input).success, false, 'loadModel options')
    t.is(loadModelSrcRequestSchema.safeParse(request).success, false, 'wire request')
  }
  t.alike(
    sdcppLoadConfigSchema
      .safeParse({ mode: 'video', performance_max_frames: 97 })
      .error?.issues.map((issue) => issue.path),
    [['performance_max_width']],
    'one issue names the first missing limit'
  )
  t.ok(sdcppLoadConfigSchema.safeParse({ mode: 'video', ...limits }).success, 'all three')
  t.ok(sdcppLoadConfigSchema.safeParse({ mode: 'video' }).success, 'none')
})

test('bounded video fit requests assess the maximum declared output', (t) => {
  const bounds = {
    performance_max_width: 512,
    performance_max_height: 320,
    performance_max_frames: 97
  }
  for (const performance_profile of ['auto', 'off'] as const) {
    const plan = fitPlan(
      sdcppConfigSchema.parse({ mode: 'video', performance_profile, vae_tiling: true, ...bounds })
    )
    const request = requestOf(plan)
    t.alike(request?.workload, { vaeTiling: true, width: 512, height: 320, videoFrames: 97 })
    t.alike(request?.config, {
      performance_profile,
      vae_tiling: true,
      ...bounds
    })
  }
})

test('unbounded video and image fit requests retain their defaults', (t) => {
  t.alike(requestOf(fitPlan({ mode: 'video' }))?.workload, { videoFrames: 33 })
  t.alike(
    requestOf(
      fitPlan({
        mode: 'diffusion',
        performance_max_width: 512,
        performance_max_height: 320,
        performance_max_frames: 97
      })
    )?.workload,
    {}
  )
})
