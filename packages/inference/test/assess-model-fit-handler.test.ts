import test from 'brittle'

import { fitModelConfig } from '@/handlers/assess-model-fit'
import { createLlamaFitRequest } from '@/resources/model-fit/native-probe/create-llama-fit-request'
import { ModelType } from '@/schemas/index'

// The fitter refuses a load with no `device`, so the workload has to go through
// the same default resolution a real load does or no verdict is ever reached.
test('handler: the fit load carries the device defaults a real load resolves', (t) => {
  const config = fitModelConfig({ kind: 'llm', contextTokens: 8192 })

  t.is(config['ctx_size'], 8192, "the caller's context is kept")
  t.ok(typeof config['device'] === 'string', 'a device is resolved')

  const plan = createLlamaFitRequest({
    modelType: ModelType.llamacppCompletion,
    modelPath: '/nonexistent/stub.gguf',
    modelConfig: config,
    isShardedModel: false
  })
  t.ok(plan.supported, 'the resolved load is one the fitter can answer for')
  if (plan.supported) {
    t.is(plan.config.params['ctx_size'], '8192')
    t.ok(plan.config.params['device'], 'the device reaches the fit request')
  }
})

test('handler: a non-llm workload resolves no llama load', (t) => {
  t.alike(fitModelConfig({ kind: 'audio', windowMs: 30_000, streaming: true }), {})
})
