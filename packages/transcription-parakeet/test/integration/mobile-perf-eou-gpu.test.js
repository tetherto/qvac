'use strict'

const test = require('brittle')
const { runMobilePerfCase } = require('./mobile-perf-runner.js')

test('Mobile perf EOU GPU', { timeout: 600000 }, async (t) => {
  await runMobilePerfCase(t, {
    modelType: 'eou',
    useGPU: true
  })
})
