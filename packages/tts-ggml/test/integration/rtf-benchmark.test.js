'use strict'

// Mobile entry point for the RTF benchmark.
//
// `npm run test:mobile:generate` registers this file in
// `test/mobile/integration.auto.cjs` as `runRtfBenchmarkTest`. On Device Farm
// the GGML `integration-runtime.cjs` dynamically imports it, and the
// `require('../benchmark/rtf-benchmark.test.js')` below resolves at runtime to
// the same canonical benchmark the desktop `test:benchmark:rtf` script invokes
// — same brittle test, same `[PERF_REPORT_START]` / `[PERF_REPORT_END]`
// markers, same per-run JSON schema. The chatterbox / supertonic GGUF weights
// are pulled from the QVAC registry at runtime via the
// `test/utils/downloadModel.js` `ensure*` helpers.
//
// `QVAC_TTS_GGML_RUN_BENCHMARK_ON_MOBILE` must be truthy for the benchmark to
// actually run — the mobile workflow's variant-injection step only sets it when
// the dispatch input `run_rtf_benchmarks: true` is passed, so a default PR
// mobile run is a near-no-op (no brittle test registers, the matrix entry goes
// green-with-skip).

const os = require('bare-os')

const flag = typeof os.getEnv === 'function' ? (os.getEnv('QVAC_TTS_GGML_RUN_BENCHMARK_ON_MOBILE') || '') : ''
const enabled = flag === '1' || flag.toLowerCase() === 'true' || flag.toLowerCase() === 'yes'

if (enabled) {
  require('../benchmark/rtf-benchmark.test.js')
} else {
  console.log('[rtf-benchmark mobile shim] QVAC_TTS_GGML_RUN_BENCHMARK_ON_MOBILE not set; skipping benchmark.')
}
