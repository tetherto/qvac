'use strict'

const test = require('brittle')
const { runMobilePerfCase } = require('./parakeet-mobile-perf-runner.js')

test('Mobile perf Unified GPU', { timeout: 600000 }, async (t) => {
  await runMobilePerfCase(t, {
    modelType: 'unified',
    useGPU: true
  })
})
