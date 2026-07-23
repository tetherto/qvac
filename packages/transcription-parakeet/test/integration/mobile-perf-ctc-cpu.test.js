'use strict'

const test = require('brittle')
const { runMobilePerfCase } = require('./mobile-perf-runner.js')

test('Mobile perf CTC CPU', { timeout: 600000 }, async (t) => {
  await runMobilePerfCase(t, {
    modelType: 'ctc',
    useGPU: false
  })
})
