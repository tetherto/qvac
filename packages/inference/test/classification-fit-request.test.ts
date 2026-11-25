import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { assessFit as classificationAssessFit } from '@qvac/classification-ggml'

import { classificationFitRequest } from '@/plugins/builtin/ggml-classification/fit'
import { imageEmbeddingFitRequest } from '@/plugins/builtin/ggml-image-embedding/fit'
import { stereoDepthFitRequest } from '@/plugins/builtin/ggml-stereo-depth/fit'
import { stereoDepthPlugin } from '@/plugins/builtin/ggml-stereo-depth/plugin'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

const MOBILENET = path.resolve('/models/mobilenet.gguf')
const CUSTOM_MOBILENET = path.resolve('/custom/mobilenet.gguf')
const MEGALOC = path.resolve('/models/megaloc.gguf')
const BRIDGEDEPTH = path.resolve('/models/bridgedepth.gguf')

function load(modelPath: string, modelConfig: unknown): FitLoad {
  return { modelPath, modelConfig, isShardedModel: false }
}

function requestOf(plan: FitRequestPlan): Record<string, unknown> | undefined {
  return 'request' in plan ? (plan.request as Record<string, unknown>) : undefined
}

test('classification: carries the load model and no placement', (t) => {
  const plan = classificationFitRequest(load(MOBILENET, { topK: 5 }))

  t.alike(requestOf(plan), { modelPath: MOBILENET })
})

test('classification: a config modelPath wins over the load model', (t) => {
  const plan = classificationFitRequest(
    load(MOBILENET, { modelPath: CUSTOM_MOBILENET })
  )

  t.is(requestOf(plan)?.['modelPath'], CUSTOM_MOBILENET)
})

test('classification: a relative config modelPath is made absolute', (t) => {
  const plan = classificationFitRequest(
    load(MOBILENET, { modelPath: 'custom/mobilenet.gguf' })
  )

  t.is(requestOf(plan)?.['modelPath'], path.resolve('custom/mobilenet.gguf'))
})

test('classification: a load with no model path is unknown', (t) => {
  t.ok('unknown' in classificationFitRequest(load('', {})))
})

test('image embedding: carries the model and the load placement', (t) => {
  const plan = imageEmbeddingFitRequest(
    load(MEGALOC, { backend: 'MTL0', threads: 4, backendsDir: '/backends' })
  )

  t.alike(requestOf(plan), {
    modelPath: MEGALOC,
    backend: 'MTL0',
    threads: 4,
    backendsDir: '/backends'
  })
})

test('image embedding: an empty config leaves placement to the addon', (t) => {
  t.alike(requestOf(imageEmbeddingFitRequest(load(MEGALOC, undefined))), {
    modelPath: MEGALOC
  })
})

test('image embedding: a relative load model path is made absolute', (t) => {
  const plan = imageEmbeddingFitRequest(load('models/megaloc.gguf', undefined))

  t.is(requestOf(plan)?.['modelPath'], path.resolve('models/megaloc.gguf'))
})

test('stereo depth: carries the model and the load placement', (t) => {
  const plan = stereoDepthFitRequest(
    load(BRIDGEDEPTH, { backend: 'MTL0', threads: 4, backendsDir: '/backends' })
  )

  t.alike(requestOf(plan), {
    modelPath: BRIDGEDEPTH,
    backend: 'MTL0',
    threads: 4,
    backendsDir: '/backends'
  })
})

test('stereo depth: an empty config leaves placement and input size to the addon', (t) => {
  t.alike(requestOf(stereoDepthFitRequest(load(BRIDGEDEPTH, undefined))), {
    modelPath: BRIDGEDEPTH
  })
})

test('stereo depth: a relative load model path is made absolute', (t) => {
  const plan = stereoDepthFitRequest(load('models/bridgedepth.gguf', undefined))

  t.is(requestOf(plan)?.['modelPath'], path.resolve('models/bridgedepth.gguf'))
})

test('stereo depth: a symlinked directory before .. resolves as the load opens it', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-fit-model-path-')))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'releases', 'v2', 'subdir'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'releases', 'v2', 'model.gguf'), 'intended')
  fs.writeFileSync(path.join(dir, 'model.gguf'), 'decoy')
  fs.symlinkSync(path.join(dir, 'releases', 'v2', 'subdir'), path.join(dir, 'current'), 'junction')

  const modelPath = [dir, 'current', '..', 'model.gguf'].join(path.sep)
  const plan = stereoDepthFitRequest(load(modelPath, undefined))

  t.is(requestOf(plan)?.['modelPath'], path.join(dir, 'releases', 'v2', 'model.gguf'))
})

test('stereo depth: the plugin sizes loads with the classification fitter', (t) => {
  t.is(stereoDepthPlugin.fitRequest, stereoDepthFitRequest)
  t.is(stereoDepthPlugin.assessFit, classificationAssessFit)
})
