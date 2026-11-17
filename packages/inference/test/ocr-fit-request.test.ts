import test from 'brittle'

import { ocrFitRequest } from '@/plugins/builtin/ggml-ocr/fit'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

function load(modelConfig: unknown, artifacts?: Record<string, string>): FitLoad {
  return { modelPath: '/models/latin.gguf', modelConfig, artifacts, isShardedModel: false }
}

function requestOf(plan: FitRequestPlan): Record<string, unknown> | undefined {
  return 'request' in plan ? (plan.request as Record<string, unknown>) : undefined
}

test('carries the detector, the recognizer and the load placement', (t) => {
  const plan = ocrFitRequest(
    load(
      { pipelineType: 'doctr', backendDevice: 'cpu' },
      { detectorModelPath: '/models/craft.gguf' }
    )
  )

  const request = requestOf(plan)
  t.is(request?.['pathDetector'], '/models/craft.gguf')
  t.is(request?.['pathRecognizer'], '/models/latin.gguf')
  t.is(request?.['pipelineType'], 'doctr')
  t.is(request?.['backendDevice'], 'cpu')
})

test('an unresolved detector is unknown', (t) => {
  t.ok('unknown' in ocrFitRequest(load({})))
})
