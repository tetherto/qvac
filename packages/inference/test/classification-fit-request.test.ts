import test from 'brittle'
import path from 'bare-path'
import { assessFit as classificationAssessFit } from '@qvac/classification-ggml'

import { classificationFitRequest } from '@/plugins/builtin/ggml-classification/fit'
import { imageEmbeddingFitRequest } from '@/plugins/builtin/ggml-image-embedding/fit'
import { stereoDepthFitRequest } from '@/plugins/builtin/ggml-stereo-depth/fit'
import { stereoDepthPlugin } from '@/plugins/builtin/ggml-stereo-depth/plugin'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

function load(modelPath: string, modelConfig: unknown): FitLoad {
  return { modelPath, modelConfig, isShardedModel: false }
}

function requestOf(plan: FitRequestPlan): Record<string, unknown> | undefined {
  return 'request' in plan ? (plan.request as Record<string, unknown>) : undefined
}

test('classification: carries the load model and no placement', (t) => {
  const plan = classificationFitRequest(load('/models/mobilenet.gguf', { topK: 5 }))

  t.alike(requestOf(plan), { modelPath: '/models/mobilenet.gguf' })
})

test('classification: a config modelPath wins over the load model', (t) => {
  const plan = classificationFitRequest(
    load('/models/mobilenet.gguf', { modelPath: '/custom/mobilenet.gguf' })
  )

  t.is(requestOf(plan)?.['modelPath'], '/custom/mobilenet.gguf')
})

test('classification: a relative config modelPath is made absolute', (t) => {
  const plan = classificationFitRequest(
    load('/models/mobilenet.gguf', { modelPath: 'custom/mobilenet.gguf' })
  )

  t.is(requestOf(plan)?.['modelPath'], path.resolve('custom/mobilenet.gguf'))
})

test('classification: a load with no model path is unknown', (t) => {
  t.ok('unknown' in classificationFitRequest(load('', {})))
})

test('image embedding: carries the model and the load placement', (t) => {
  const plan = imageEmbeddingFitRequest(
    load('/models/megaloc.gguf', { backend: 'MTL0', threads: 4, backendsDir: '/backends' })
  )

  t.alike(requestOf(plan), {
    modelPath: '/models/megaloc.gguf',
    backend: 'MTL0',
    threads: 4,
    backendsDir: '/backends'
  })
})

test('image embedding: an empty config leaves placement to the addon', (t) => {
  t.alike(requestOf(imageEmbeddingFitRequest(load('/models/megaloc.gguf', undefined))), {
    modelPath: '/models/megaloc.gguf'
  })
})

test('stereo depth: carries the model and the load placement', (t) => {
  const plan = stereoDepthFitRequest(
    load('/models/bridgedepth.gguf', { backend: 'MTL0', threads: 4, backendsDir: '/backends' })
  )

  t.alike(requestOf(plan), {
    modelPath: '/models/bridgedepth.gguf',
    backend: 'MTL0',
    threads: 4,
    backendsDir: '/backends'
  })
})

test('stereo depth: an empty config leaves placement and input size to the addon', (t) => {
  t.alike(requestOf(stereoDepthFitRequest(load('/models/bridgedepth.gguf', undefined))), {
    modelPath: '/models/bridgedepth.gguf'
  })
})

test('stereo depth: the plugin sizes loads with the classification fitter', (t) => {
  t.is(stereoDepthPlugin.fitRequest, stereoDepthFitRequest)
  t.is(stereoDepthPlugin.assessFit, classificationAssessFit)
})
