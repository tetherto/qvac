'use strict'

const test = require('brittle')
const { runMobilePerfCase } = require('./mobile-perf-runner.js')

// GPU quantization sweep — the GPU counterpart to mobile-perf-sweep-cpu.test.js.
// These cases are ordered AFTER every CPU case (and the wrapper functions in
// test/mobile/integration.auto.cjs are listed after the CPU sweep, before the
// final tiny-GPU case) because Whisper's GPU teardown has historically crashed
// the bare app on some Adreno devices at context/process shutdown
// (whisper.cpp#2373). Running GPU last means a teardown crash cannot drop the
// coverage of any earlier (CPU) case. The mobile job is continue-on-error, so a
// crash here is non-blocking. NO_GPU=true still skips the GPU half inside
// runMobilePerfCase. fp16 excluded for the same on-device download-size reason
// as the CPU sweep.
const GPU_SWEEP = [
  'ggml-base-q5_1.bin',
  'ggml-base-q8_0.bin',
  'ggml-small-q5_1.bin',
  'ggml-small-q8_0.bin'
]

for (const modelFile of GPU_SWEEP) {
  test('Mobile perf ' + modelFile.replace(/\.bin$/, '') + ' GPU', { timeout: 600000 }, async (t) => {
    await runMobilePerfCase(t, {
      modelFile,
      useGPU: true
    })
  })
}
