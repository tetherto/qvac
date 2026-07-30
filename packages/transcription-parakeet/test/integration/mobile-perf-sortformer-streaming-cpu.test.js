'use strict'

const test = require('brittle')
const { runMobilePerfCase } = require('./mobile-perf-runner.js')

test('Mobile perf Sortformer-Streaming (v2.1) CPU', { timeout: 600000 }, async (t) => {
  await runMobilePerfCase(t, {
    modelType: 'sortformer-streaming',
    useGPU: false,
    quants: ['q4_0', 'q8_0']
  })
})
