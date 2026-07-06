'use strict'

const test = require('brittle')
const { runMobilePerfCase } = require('./mobile-perf-runner.js')

// CPU throughput perf case for the single BCI model. Runs on the mobile Device
// Farm leg (skips on desktop). Ordered before the GPU case — see
// mobile-perf-gpu.test.js for the GPU-teardown crash-isolation rationale.
test('Mobile perf BCI CPU', { timeout: 600000 }, async (t) => {
  await runMobilePerfCase(t, {
    modelFile: 'ggml-bci-windowed.bin',
    useGPU: false
  })
})
