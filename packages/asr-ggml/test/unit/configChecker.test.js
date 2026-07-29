'use strict'

const test = require('brittle')
const { checkConfig } = require('../../configChecker')

function baseConfig(whisperConfig = {}) {
  return {
    whisperConfig: { language: 'en', ...whisperConfig },
    contextParams: { model: 'ggml-tiny.bin' },
    miscConfig: { caption_enabled: false }
  }
}

function assertThrows(t, fn, pattern, message) {
  try {
    fn()
    t.fail(message)
  } catch (err) {
    t.ok(pattern.test(err.message), `${message} (got: ${err.message})`)
  }
}

test('checkConfig accepts a minimal valid configuration', (t) => {
  checkConfig(baseConfig())
  t.pass('valid configuration should not throw')
})

test('checkConfig rejects detect_language regardless of value', (t) => {
  assertThrows(
    t,
    () => checkConfig(baseConfig({ detect_language: true })),
    /detect_language is not a valid parameter/,
    'detect_language: true must be rejected'
  )
  assertThrows(
    t,
    () => checkConfig(baseConfig({ detect_language: false })),
    /detect_language is not a valid parameter/,
    'detect_language: false must be rejected'
  )
})

test('checkConfig accepts max_initial_ts and no_speech_thold', (t) => {
  checkConfig(baseConfig({ max_initial_ts: 1.0, no_speech_thold: 0.6 }))
  t.pass('whitelisted whisper params should not throw')
})

test('checkConfig rejects max_seconds when it reaches the validator', (t) => {
  assertThrows(
    t,
    () => checkConfig(baseConfig({ max_seconds: 30 })),
    /max_seconds is not a valid parameter/,
    'max_seconds must be stripped before validation, not passed through'
  )
})
