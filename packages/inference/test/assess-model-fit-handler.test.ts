import test from 'brittle'

import { fitLoad } from '@/handlers/assess-model-fit'
import { createLlamaFitRequest } from '@/resources/model-fit/native-probe/create-llama-fit-request'
import type { ModelFitCandidate } from '@/schemas/assess-model-fit'
import type { ModelResourceProfile } from '@/schemas/model-resource-profile'
import { ModelType } from '@/schemas/index'

const MODEL = { name: 'MODEL', sha256Checksum: 'a'.repeat(64) }

function llm(contextTokens = 8192): ModelFitCandidate {
  return { model: MODEL, workload: { kind: 'llm', contextTokens } }
}

function profileFor(engine: ModelResourceProfile['engine']) {
  return () => ({ engine }) as ModelResourceProfile
}

// The fitter refuses a load with no `device`, so the workload has to go through
// the same default resolution a real load does or no verdict is ever reached.
test('handler: a completion load carries the device defaults a real load resolves', (t) => {
  const load = fitLoad(llm(), profileFor(ModelType.llamacppCompletion))

  t.ok(load, 'a completion model has a fitter')
  if (!load) return
  t.is(load.modelType, ModelType.llamacppCompletion)
  t.is(load.modelConfig['ctx_size'], 8192, "the caller's context is kept")
  t.ok(typeof load.modelConfig['device'] === 'string', 'a device is resolved')

  const plan = createLlamaFitRequest({
    modelType: load.modelType,
    modelPath: '/nonexistent/stub.gguf',
    modelConfig: load.modelConfig,
    isShardedModel: false
  })
  t.ok(plan.supported, 'the resolved load is one the fitter can answer for')
  if (plan.supported) {
    t.is(plan.config.params['ctx_size'], '8192')
    t.ok(plan.config.params['device'], 'the device reaches the fit request')
  }
})

// An embedding model asked for a completion context larger than it declares
// is an error to the fitter, not a verdict. The catalog knows the engine.
test('handler: an embedding model is fitted as an embedding load, without a context', (t) => {
  const load = fitLoad(llm(), profileFor(ModelType.llamacppEmbedding))

  t.ok(load, 'an embedding model has a fitter')
  if (!load) return
  t.is(load.modelType, ModelType.llamacppEmbedding)
  t.absent(load.modelConfig['ctx_size'], 'the fitter reads the window the model declares')
  t.ok(typeof load.modelConfig['device'] === 'string', 'a device is resolved')

  const plan = createLlamaFitRequest({
    modelType: load.modelType,
    modelPath: '/nonexistent/stub.gguf',
    modelConfig: load.modelConfig,
    isShardedModel: false
  })
  t.ok(plan.supported, 'the resolved embedding load is one the fitter can answer for')
  if (plan.supported) t.is(plan.loadKind, 'embedding')
})

// The estimator adds companion bytes; the fitter would read one file and answer
// for the model alone, so the set must keep the estimate.
test('handler: a candidate with companion artifacts gets no fitter', (t) => {
  const candidate: ModelFitCandidate = { ...llm(), artifacts: [MODEL] }

  t.absent(fitLoad(candidate, profileFor(ModelType.llamacppCompletion)))
})

test('handler: a model outside the catalog is fitted as a completion load', (t) => {
  const load = fitLoad(llm(4096), () => undefined)

  t.is(load?.modelType, ModelType.llamacppCompletion)
  t.is(load?.modelConfig['ctx_size'], 4096)
})

test('handler: an engine with no fit path resolves no load', (t) => {
  t.absent(fitLoad(llm(), profileFor(ModelType.ttsGgml)))
})

test('handler: a non-llm workload resolves no load', (t) => {
  const candidate: ModelFitCandidate = {
    model: MODEL,
    workload: { kind: 'audio', windowMs: 30_000, streaming: true }
  }
  t.absent(fitLoad(candidate, profileFor(ModelType.whispercppTranscription)))
})
