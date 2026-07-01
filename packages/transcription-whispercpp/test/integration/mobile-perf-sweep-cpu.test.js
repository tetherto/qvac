'use strict'

const test = require('brittle')
const { runMobilePerfCase } = require('./mobile-perf-runner.js')

// CPU quantization sweep — mirrors the desktop benchmark matrix on mobile so
// the perf report can compare quants side by side across desktop and device.
// Each model is its own test() so it gets its own timeout budget (on-device HF
// download + 3 measured runs). fp16 (plain ggml-base/small.bin) is deliberately
// excluded on mobile: small.bin is ~488MB, too heavy to pull over the Device
// Farm network per session — the quantized builds (q5_1 / q8_0) are the
// mobile-shippable ones. CPU cases run before any GPU case (see
// mobile-perf-sweep-gpu.test.js for the GPU-teardown crash-isolation rationale).
const CPU_SWEEP = [
  'ggml-base-q5_1.bin',
  'ggml-base-q8_0.bin',
  'ggml-small-q5_1.bin',
  'ggml-small-q8_0.bin'
]

for (const modelFile of CPU_SWEEP) {
  test('Mobile perf ' + modelFile.replace(/\.bin$/, '') + ' CPU', { timeout: 600000 }, async (t) => {
    await runMobilePerfCase(t, {
      modelFile,
      useGPU: false
    })
  })
}
