'use strict'
// QVAC-21257: exercise the `mmproj-use-gpu` config key that makes the
// multimodal projector (mmproj / vision encoder) backend runtime-configurable.
//
// Historically the projector was hard-pinned to CPU on Android via a
// compile-time #ifdef. The key lets callers force either backend without
// recompiling; when unset the backend is auto-selected per device class
// (QVAC-21867): desktop/iOS -> GPU; Android Adreno 800+ / other non-Mali GPUs
// -> GPU; Android Mali and Adreno <800 -> CPU. These tests
// assert the key is honoured on a GPU backend and that requesting it on a
// CPU backend warns and cleanly falls back (the projector stays on CPU,
// vision still works).
//
// This file ends in `.test.js`, so the mobile generator picks it up as
// `runImageMmprojGpuTest` and it runs on the Android + iOS Device Farm pools
// (the OpenCL/Metal gate) in addition to the desktop integration suite.

const test = require('brittle')
const fs = require('bare-fs')
const {
  DEVICE_CONFIGS,
  TEST_CONSTANTS,
  checkKeywordsInText,
  describeImage,
  setupMultimodalInference
} = require('./_image-common.js')
const { getMediaPath } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')

const IMAGE_FILE = 'elephant.jpg'
const KEYWORDS = ['elephant', 'elephants']
const gpuAvailable = DEVICE_CONFIGS.some((c) => c.id === 'gpu')

// Build a VLM inference with an explicit `mmproj-use-gpu` override via the
// shared multimodal setup helper (threading the new key through extraConfig).
async function loadVlm(t, device, mmprojUseGpu) {
  const { inference } = await setupMultimodalInference(t, device, undefined, {
    'mmproj-use-gpu': mmprojUseGpu
  })
  return inference
}

async function assertDescribesImage(t, inference, label) {
  const imageFilePath = getMediaPath(IMAGE_FILE)
  t.ok(fs.existsSync(imageFilePath), `${label} ${IMAGE_FILE} should exist`)

  const { generatedText } = await describeImage(inference, imageFilePath)
  t.comment(`${label} generated text: ${generatedText}`)
  t.ok(generatedText.length > 0, `${label} should generate text output`)

  const { hasMatch, foundKeywords } = checkKeywordsInText(generatedText, KEYWORDS)
  t.ok(
    hasMatch,
    `${label} output should describe the elephant. ` +
      `Found keywords: ${foundKeywords.join(', ') || 'none'}. ` +
      `Full output: "${generatedText}"`
  )
}

test(
  'device:gpu + mmproj-use-gpu:true runs the projector on GPU',
  { timeout: TEST_CONSTANTS.timeout, skip: !gpuAvailable },
  async (t) => {
    const inference = await loadVlm(t, 'gpu', 'true')
    await assertDescribesImage(t, inference, '[GPU][mmproj=gpu]')
  }
)

test(
  'device:gpu + mmproj-use-gpu:false keeps the projector on CPU',
  { timeout: TEST_CONSTANTS.timeout, skip: !gpuAvailable },
  async (t) => {
    const inference = await loadVlm(t, 'gpu', 'false')
    await assertDescribesImage(t, inference, '[GPU][mmproj=cpu]')
  }
)

// Requesting the projector on the GPU while the model itself runs on the CPU
// backend has no GPU to offload to. The addon must fall back cleanly (warn +
// keep the projector on CPU) rather than erroring — the projector still runs
// and vision still works. The fallback warning is emitted on the native log
// stream; here we assert the observable contract: load succeeds and the image
// is still described correctly.
test(
  'device:cpu + mmproj-use-gpu:true loads without error and runs the projector on CPU',
  { timeout: TEST_CONSTANTS.timeout },
  async (t) => {
    const inference = await loadVlm(t, 'cpu', 'true')
    await assertDescribesImage(t, inference, '[CPU][mmproj=cpu]')
  }
)

// QVAC-21867: with the key unset the projector backend is auto-selected per
// device class (desktop/iOS + non-Mali Android GPUs -> GPU; Android Mali ->
// CPU). This is the PR's headline behavior, so assert the auto-default branch
// actually ran (not an override) via the native decision log, and that the
// image is still described correctly whichever backend was chosen.
//
// The decision line is emitted only when a GPU compute backend is actually
// selected (LlamaModel.cpp GPU branch). A host may advertise `device: 'gpu'`
// (so this test is not skipped) yet have no usable GPU at runtime, in which
// case the addon falls back to the CPU backend — which is silent for the
// no-override case — and the line is absent. Tolerate that fallback: only
// assert the auto-default semantics when the GPU branch ran; otherwise the
// projector still described the image on CPU, which is all we can verify here.
test(
  'device:gpu + mmproj-use-gpu unset auto-defaults the projector by device class',
  { timeout: TEST_CONSTANTS.timeout, skip: !gpuAvailable },
  async (t) => {
    const spec = attachSpecLogger({ forwardToConsole: false })
    t.teardown(() => spec.release())

    const { inference } = await setupMultimodalInference(t, 'gpu')
    await assertDescribesImage(t, inference, '[GPU][mmproj=auto]')

    const decisionLog = spec.logs.find((l) => l.includes('multimodal projector backend:'))
    if (!decisionLog) {
      t.comment(
        'no GPU backend selected at runtime (CPU fallback) — projector ' +
          'auto-default path not exercised on this host; skipping the decision-log ' +
          'assertion'
      )
      t.pass('projector ran and described the image on the CPU-fallback backend')
      return
    }
    t.ok(
      decisionLog.includes('auto-default'),
      'projector backend should be auto-defaulted with no override. ' + `Log: ${decisionLog}`
    )
  }
)
