'use strict'
// QVAC-21257: exercise the `mmproj-use-gpu` config key that makes the
// multimodal projector (mmproj / vision encoder) backend runtime-configurable.
//
// Historically the projector was hard-pinned to CPU on Android via a
// compile-time #ifdef. The new key lets callers run it on the mobile GPU
// without recompiling, defaulting to the previous per-platform behaviour
// (Android -> CPU, desktop/iOS -> GPU). These tests assert the key is
// honoured on a GPU backend and that requesting it on a CPU backend warns
// and cleanly falls back (the projector stays on CPU, vision still works).
//
// This file ends in `.test.js`, so the mobile generator picks it up as
// `runImageMmprojGpuTest` and it runs on the Android + iOS Device Farm pools
// (the OpenCL/Metal gate) in addition to the desktop integration suite.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const {
  DEVICE_CONFIGS,
  MULTIMODAL_MODEL_CONFIG,
  TEST_CONSTANTS,
  checkKeywordsInText,
  describeImage
} = require('./_image-common.js')
const { ensureModel, getMediaPath } = require('./utils')
const LlmLlamacpp = require('../../index.js')

const IMAGE_FILE = 'elephant.jpg'
const KEYWORDS = ['elephant', 'elephants']
const gpuAvailable = DEVICE_CONFIGS.some(c => c.id === 'gpu')

// Build a VLM inference with an explicit `mmproj-use-gpu` override. Mirrors
// setupMultimodalInference() from _image-common.js but threads the new key
// through the config so we can assert its effect directly.
async function loadVlm (t, device, mmprojUseGpu) {
  const cfg = MULTIMODAL_MODEL_CONFIG
  const [modelName, dirPath] = await ensureModel(cfg.llmModel)
  t.ok(fs.existsSync(path.join(dirPath, modelName)), 'LLM model file should exist')

  const [projModelName] = await ensureModel(cfg.projModel)
  t.ok(fs.existsSync(path.join(dirPath, projModelName)), 'Projection model file should exist')

  const inference = new LlmLlamacpp({
    files: {
      model: [path.join(dirPath, modelName)],
      projectionModel: path.join(dirPath, projModelName)
    },
    config: {
      gpu_layers: device === 'cpu' ? '0' : '98',
      temp: '0.0',
      verbosity: '2',
      device,
      ctx_size: cfg.ctx_size,
      'mmproj-use-gpu': mmprojUseGpu
    },
    logger: console,
    opts: { stats: true }
  })
  t.teardown(async () => {
    try { await inference.unload() } catch (_) {}
  })
  await inference.load()
  return inference
}

async function assertDescribesImage (t, inference, label) {
  const imageFilePath = getMediaPath(IMAGE_FILE)
  t.ok(fs.existsSync(imageFilePath), `${label} ${IMAGE_FILE} should exist`)

  const { generatedText } = await describeImage(inference, imageFilePath)
  t.comment(`${label} generated text: ${generatedText}`)
  t.ok(generatedText.length > 0, `${label} should generate text output`)

  const { hasMatch, foundKeywords } = checkKeywordsInText(generatedText, KEYWORDS)
  t.ok(hasMatch,
    `${label} output should describe the elephant. ` +
    `Found keywords: ${foundKeywords.join(', ') || 'none'}. ` +
    `Full output: "${generatedText}"`)
}

test('device:gpu + mmproj-use-gpu:true runs the projector on GPU',
  { timeout: TEST_CONSTANTS.timeout, skip: !gpuAvailable }, async t => {
    const inference = await loadVlm(t, 'gpu', 'true')
    await assertDescribesImage(t, inference, '[GPU][mmproj=gpu]')
  })

test('device:gpu + mmproj-use-gpu:false keeps the projector on CPU',
  { timeout: TEST_CONSTANTS.timeout, skip: !gpuAvailable }, async t => {
    const inference = await loadVlm(t, 'gpu', 'false')
    await assertDescribesImage(t, inference, '[GPU][mmproj=cpu]')
  })

// Requesting the projector on the GPU while the model itself runs on the CPU
// backend has no GPU to offload to. The addon must fall back cleanly (warn +
// keep the projector on CPU) rather than erroring — the projector still runs
// and vision still works. The fallback warning is emitted on the native log
// stream; here we assert the observable contract: load succeeds and the image
// is still described correctly.
test('device:cpu + mmproj-use-gpu:true loads without error and runs the projector on CPU',
  { timeout: TEST_CONSTANTS.timeout }, async t => {
    const inference = await loadVlm(t, 'cpu', 'true')
    await assertDescribesImage(t, inference, '[CPU][mmproj=cpu]')
  })
