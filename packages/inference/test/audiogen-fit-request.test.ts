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
