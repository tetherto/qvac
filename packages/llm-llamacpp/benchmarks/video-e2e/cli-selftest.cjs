'use strict'
const assert = require('node:assert/strict')
const { metrics, responseText } = require('./run-cli.cjs')
assert.equal(responseText('VIDEO_E2E_RESPONSE_BEG'), '')
assert.equal(responseText('VIDEO_E2E_RESPONSE_BEGIN\n'), '')
assert.equal(responseText('VIDEO_E2E_RESPONSE_BEGIN\nThe'), 'The')
assert.equal(responseText('startup output\nVIDEO_E2E_RESPONSE_BEGIN\nThe clip.'), 'The clip.')
const parsed = metrics(
  [
    'mtmd batch encoding done in 12.3 ms',
    'mtmd batch encoding done in 20.0 ms',
    'llama_perf_context_print: load time = 987.00 ms',
    'llama_perf_context_print: prompt eval time = 123.45 ms / 640 tokens',
    'llama_perf_context_print: eval time = 99.12 ms / 47 runs'
  ].join('\n')
)
assert.equal(parsed.visionEncodeMs, 32.3)
assert.equal(parsed.promptEvalMs, 123.45)
assert.equal(parsed.promptTokens, 640)
assert.equal(parsed.generationEvalMs, 99.12)
assert.equal(parsed.generationEvalRuns, 47)
assert.equal(metrics('no timing output').promptEvalMs, null)
console.log('CLI parser checks passed, including the pre-inference response marker.')
