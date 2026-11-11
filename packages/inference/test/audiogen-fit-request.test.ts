import test from 'brittle'

import { audiogenFitRequest } from '@/plugins/builtin/audiogen-ggml/fit'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

function load(modelConfig: unknown, artifacts: Record<string, string>): FitLoad {
  return { modelPath: '', modelConfig, artifacts, isShardedModel: false }
}

function requestOf(plan: FitRequestPlan): Record<string, unknown> | undefined {
  return 'request' in plan ? (plan.request as Record<string, unknown>) : undefined
}

const ACE_STEP = {
  textEncModelPath: '/models/textenc.gguf',
  lmModelPath: '/models/lm.gguf',
  ditModelPath: '/models/dit.gguf',
  vaeModelPath: '/models/vae.gguf'
}

test('ACE-Step: carries the four stages and the load placement', (t) => {
  const plan = audiogenFitRequest(load({ useGPU: true, nGpuLayers: 99, threads: 4 }, ACE_STEP))

  t.alike(requestOf(plan), {
    textEncoderPath: '/models/textenc.gguf',
    lmPath: '/models/lm.gguf',
    ditPath: '/models/dit.gguf',
    vaePath: '/models/vae.gguf',
    gpuLayers: 99,
    threads: 4
  })
})

// A named backend puts a stage on its own device, so the fitter has to be told
// the placement the load will ask for, or it sizes the automatic one instead.
test('ACE-Step: the named backends reach the fitter', (t) => {
  const plan = audiogenFitRequest(
    load({ useGPU: true, backend: 'CUDA0', lmBackend: 'cpu' }, ACE_STEP)
  )
  t.is(requestOf(plan)?.['backend'], 'CUDA0')
  t.is(requestOf(plan)?.['lmBackend'], 'cpu')

  const automatic = requestOf(audiogenFitRequest(load({ useGPU: true }, ACE_STEP)))
  t.absent(automatic && 'backend' in automatic, 'unset leaves placement to the engine')
  t.absent(automatic && 'lmBackend' in automatic)
  t.absent(
    'dumpStagesDir' in (requestOf(plan) ?? {}),
    'the stage dumps are diagnostics, not placement'
  )
})

test('ACE-Step: a missing stage is unknown, and the CPU is no offload', (t) => {
  const { vaeModelPath: _vae, ...partial } = ACE_STEP
  t.ok('unknown' in audiogenFitRequest(load({ useGPU: true }, partial)))
  t.is(requestOf(audiogenFitRequest(load({ useGPU: false }, ACE_STEP)))?.['gpuLayers'], 0)
})

test('MiniMax: carries the pair, and the device wins over the GPU switch', (t) => {
  const pair = { lmModelPath: '/models/mm3-lm.gguf', synthModelPath: '/models/mm3-synth.gguf' }

  t.alike(requestOf(audiogenFitRequest(load({ engine: 'minimax', device: 'cpu' }, pair))), {
    engine: 'minimax',
    lmPath: '/models/mm3-lm.gguf',
    synthPath: '/models/mm3-synth.gguf',
    device: 'cpu'
  })
  t.is(
    requestOf(audiogenFitRequest(load({ engine: 'minimax', useGPU: true }, pair)))?.['gpuLayers'],
    1
  )
  t.ok('unknown' in audiogenFitRequest(load({ engine: 'minimax' }, {})), 'an unresolved pair')
})

// The fitter cannot size the Core ML route and says so; the request still has
// to name it, or the answer would describe the native backend instead.
test('MiniMax: the Core ML profile reaches the fitter', (t) => {
  const pair = { lmModelPath: '/models/mm3-lm.gguf', synthModelPath: '/models/mm3-synth.gguf' }
  const coreml = { coremlProfileDir: '/models/minimax-coreml', coremlComputeUnits: 'CPU_AND_NE' }

  t.alike(requestOf(audiogenFitRequest(load({ engine: 'minimax', ...coreml }, pair))), {
    engine: 'minimax',
    lmPath: '/models/mm3-lm.gguf',
    synthPath: '/models/mm3-synth.gguf',
    gpuLayers: 0,
    ...coreml
  })
})

test('MiniMax: the Core ML conditioner reaches the fitter', (t) => {
  const pair = { lmModelPath: '/models/mm3-lm.gguf', synthModelPath: '/models/mm3-synth.gguf' }
  const coremlConditionerPath = '/models/minimax-conditioner.mlmodelc'

  t.alike(
    requestOf(
      audiogenFitRequest(load({ engine: 'minimax', device: 'gpu', coremlConditionerPath }, pair))
    ),
    {
      engine: 'minimax',
      lmPath: '/models/mm3-lm.gguf',
      synthPath: '/models/mm3-synth.gguf',
      device: 'gpu',
      coremlConditionerPath
    }
  )
})
