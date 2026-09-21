'use strict'

const test = require('brittle')
const { runMobilePerfCase } = require('./mobile-perf-runner.js')

test('Mobile perf tiny CPU', { timeout: 600000 }, async (t) => {
  await runMobilePerfCase(t, {
    modelFile: 'ggml-tiny.bin',
    useGPU: false
  })
})
