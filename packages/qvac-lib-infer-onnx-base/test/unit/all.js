'use strict'

const test = require('brittle')

test('Module exports are defined', async function (t) {
  const onnxAddon = require('../..')

  t.ok(onnxAddon.OnnxSession, 'OnnxSession class should be exported')
  t.ok(typeof onnxAddon.createSession === 'function', 'createSession should be a function')
  t.ok(typeof onnxAddon.destroySession === 'function', 'destroySession should be a function')
  t.ok(typeof onnxAddon.getInputInfo === 'function', 'getInputInfo should be a function')
  t.ok(typeof onnxAddon.getOutputInfo === 'function', 'getOutputInfo should be a function')
  t.ok(typeof onnxAddon.run === 'function', 'run should be a function')
  t.ok(typeof onnxAddon.getCacheStats === 'function', 'getCacheStats should be a function')
})

test('getCacheStats returns valid structure without session', async function (t) {
  const { getCacheStats } = require('../..')

  const stats = getCacheStats()

  t.ok(typeof stats === 'object', 'stats should be an object')
  t.ok(typeof stats.sessionCount === 'number', 'sessionCount should be a number')
  t.ok(Array.isArray(stats.sessions), 'sessions should be an array')
})
