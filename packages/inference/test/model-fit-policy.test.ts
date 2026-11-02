import test from 'brittle'

import {
  DEFAULT_MODEL_FIT_POLICY,
  modelFitPolicySchema,
  refusesLoad,
  resolveModelFitPolicy,
  runsProbe
} from '@/schemas/model-fit-policy'
import { loadModelOptionsToRequestSchema, loadModelSrcRequestSchema } from '@/schemas/load-model'
import { ModelType } from '@/schemas'

test('modelFitPolicy: the schema takes the three policies and nothing else', (t) => {
  for (const policy of ['log', 'refuse', 'off']) {
    t.is(modelFitPolicySchema.safeParse(policy).success, true, policy)
  }

  t.is(modelFitPolicySchema.safeParse('none').success, false)
  t.is(modelFitPolicySchema.safeParse('warn').success, false)
  t.is(modelFitPolicySchema.safeParse(true).success, false)
})

test('modelFitPolicy: the load overrides the config, which overrides the default', (t) => {
  t.is(DEFAULT_MODEL_FIT_POLICY, 'log')
  t.is(resolveModelFitPolicy(undefined, undefined), 'log')
  t.is(resolveModelFitPolicy(undefined, 'refuse'), 'refuse')
  t.is(resolveModelFitPolicy('off', 'refuse'), 'off')
  t.is(resolveModelFitPolicy('log', 'off'), 'log')
})

test('modelFitPolicy: only off skips the probe', (t) => {
  t.is(runsProbe('log'), true)
  t.is(runsProbe('refuse'), true)
  t.is(runsProbe('off'), false)
})

test('modelFitPolicy: only a measured refusal under refuse blocks the load', (t) => {
  t.is(refusesLoad('refuse', 'does-not-fit'), true)
  t.is(refusesLoad('refuse', 'unknown'), false)
  t.is(refusesLoad('refuse', 'fit'), false)
  t.is(refusesLoad('refuse', undefined), false)

  t.is(refusesLoad('log', 'does-not-fit'), false)
  t.is(refusesLoad('off', 'does-not-fit'), false)
})

test('loadModelSrcRequestSchema: carries modelFitPolicy and rejects an unknown one', (t) => {
  const request = {
    type: 'loadModel',
    modelType: ModelType.llamacppCompletion,
    modelSrc: 'model.gguf',
    modelConfig: {},
    modelFitPolicy: 'refuse'
  }

  const result = loadModelSrcRequestSchema.safeParse(request)
  t.is(result.success, true)
  if (result.success) t.is(result.data.modelFitPolicy, 'refuse')

  t.is(loadModelSrcRequestSchema.safeParse({ ...request, modelFitPolicy: 'none' }).success, false)
})

test('loadModelOptionsToRequestSchema: carries modelFitPolicy from options into the request', (t) => {
  const request = loadModelOptionsToRequestSchema.parse({
    modelType: ModelType.llamacppCompletion,
    modelSrc: 'model.gguf',
    modelFitPolicy: 'off'
  })

  t.is(request.modelFitPolicy, 'off')
})

test('loadModelOptionsToRequestSchema: an unset policy stays absent from the request', (t) => {
  const request = loadModelOptionsToRequestSchema.parse({
    modelType: ModelType.llamacppCompletion,
    modelSrc: 'model.gguf'
  })

  t.absent(request.modelFitPolicy)
})
