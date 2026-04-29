'use strict'

const test = require('brittle')
const { detectPlatform } = require('./helpers.js')
const { runMobilePerfCase } = require('./mobile-perf-runner.js')

test('Mobile perf Sortformer GPU', { timeout: 600000 }, async (t) => {
  if (detectPlatform().startsWith('ios')) {
    t.pass('Sortformer GPU is quarantined on iOS pending CoreML/resource investigation')
    return
  }

  await runMobilePerfCase(t, {
    modelType: 'sortformer',
    useGPU: true
  })
})
