'use strict'

const test = require('brittle')
const { runMobilePerfCase } = require('./mobile-perf-runner.js')

// GPU throughput perf case for the single BCI model. Sorts last among the
// mobile runners (generate-mobile-tests.js orders test files alphabetically,
// and 'mobile-perf-gpu' is last), so a GPU-teardown crash on some Adreno
// devices at context/process shutdown (the BCI engine wraps whisper.cpp;
// whisper.cpp#2373) cannot drop coverage of earlier (CPU) cases. The mobile job
// is continue-on-error, so a crash here is non-blocking. NO_GPU=true still skips
// the GPU half inside runMobilePerfCase.
test('Mobile perf BCI GPU', { timeout: 600000 }, async (t) => {
  await runMobilePerfCase(t, {
    modelFile: 'ggml-bci-windowed.bin',
    useGPU: true
  })
})
