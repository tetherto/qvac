'use strict'

// Checks the gpuFallbackReason code table and its lookup helper: every code the
// engine's tts_cpp::GpuFallbackReason can emit resolves to a name, and an
// unset or unknown code resolves to undefined rather than a guess.

const test = require('brittle')
const { AUDIOGEN_GPU_FALLBACK_REASONS, audiogenGpuFallbackReason } = require('../../index.js')

test('every engine code maps to a name', (t) => {
  t.is(audiogenGpuFallbackReason(0), 'none')
  t.is(audiogenGpuFallbackReason(1), 'not-requested')
  t.is(audiogenGpuFallbackReason(2), 'no-devices')
  t.is(audiogenGpuFallbackReason(3), 'init-failed')
})

test('the table covers the enum with no gaps', (t) => {
  t.alike(Object.keys(AUDIOGEN_GPU_FALLBACK_REASONS).map(Number), [0, 1, 2, 3])
})

test('an unset or unknown code is undefined, never a guess', (t) => {
  t.is(audiogenGpuFallbackReason(undefined), undefined)
  t.is(audiogenGpuFallbackReason(99), undefined)
  t.is(audiogenGpuFallbackReason(-1), undefined)
})
