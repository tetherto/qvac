'use strict'

const test = require('brittle')
const { getImagePath, runDoctrWarmProfile, ensureDoctrModels } = require('./utils')

const DOCTR_TEST_TIMEOUT = 180 * 1000

test('DocTR warm profile [VULKAN] - cold vs warm runs', { timeout: DOCTR_TEST_TIMEOUT }, async function (t) {
  // Resolve models the same way as the clinical-chemistry suite: on desktop ->
  // ./models/<name> (or OCR_GGML_DOCTR_* env); on mobile -> downloaded from the
  // presigned URLs in ocr-ggml-model-urls.json and cached in GGML_MODELS_DIR
  // (the clinical test runs first in the perf group, so this hits the cache).
  // The earlier testAssets path could not resolve the .gguf models on device
  // (they are not registered in global.assetPaths), so the warm profile was
  // silently skipped and the warm Pixel number never reached CI.
  const models = await ensureDoctrModels()
  if (!models) {
    t.comment('DocTR models unavailable (download failed) — warm test skipped')
    return
  }
  const imagePath = getImagePath('/test/images/clinical_chemistry.png')
  // Confirmation profile: everything at defaults (auto-hybrid + CPU-assist
  // recognition + LSTM split). Logs per-run detection/recognition timings,
  // box count, and the clinical-chemistry keyword guard for each warm run, and
  // records the fastest warm run to the perf report.
  await runDoctrWarmProfile(t, {
    label: ':auto',
    params: {
      pathDetector: models.db_mobilenet_v3_large,
      pathRecognizer: models.crnn_mobilenet_v3_small
    },
    imagePath,
    runs: 3
  })
})
