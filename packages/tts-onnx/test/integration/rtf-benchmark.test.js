'use strict'

// Mobile entry point for the RTF benchmark.
//
// This file is what `qvac-test-addon-mobile/scripts/build-test-app.js` will
// register in `integrationModuleLoaders` when `npm run test:mobile:generate`
// regenerates `test/mobile/integration.auto.cjs`. The framework's
// `syncIntegrationTests` step copies the entire addon `test/` tree into
// `backend/test/`, so the relative `require('../benchmark/rtf-benchmark.test.js')`
// below resolves at runtime to the same desktop benchmark file the
// `test:benchmark:rtf` package script invokes — same brittle test, same
// `[PERF_REPORT_START]` / `[PERF_REPORT_END]` markers, same per-run JSON
// schema. The chatterbox / supertonic q4 weights are pulled from
// HuggingFace at runtime via `bare-https` (see `test/utils/downloadModel.js`),
// confirmed working on Device Farm in run #25489423139 jobs
// 74794692423 / 74794692442 / 74794692443 / 74794692446 (Pixel 9, Galaxy S25
// Ultra, iPhone 16 Pro, iPhone 16e all reached HuggingFace and downloaded
// the speech-encoder weights), so model availability is not a blocker.
//
// `QVAC_ONNX_TTS_RUN_BENCHMARK_ON_MOBILE` must be truthy for the benchmark
// to actually run — the workflow's `Inject Variant for Mobile Tests` step
// only sets it when the dispatch input `run_rtf_benchmarks: true` is
// passed, so the default PR mobile run is a near-no-op (no brittle tests
// register, framework returns the empty `{ summary: { total: 0, passed: 0,
// failed: 0 } }` from the no-runner branch, matrix entry goes
// green-with-skip).

const os = require('bare-os')

const flag = typeof os.getEnv === 'function' ? (os.getEnv('QVAC_ONNX_TTS_RUN_BENCHMARK_ON_MOBILE') || '') : ''
const enabled = flag === '1' || flag.toLowerCase() === 'true' || flag.toLowerCase() === 'yes'

if (enabled) {
  require('../benchmark/rtf-benchmark.test.js')
} else {
  console.log('[rtf-benchmark mobile shim] QVAC_ONNX_TTS_RUN_BENCHMARK_ON_MOBILE not set; skipping benchmark.')
}
