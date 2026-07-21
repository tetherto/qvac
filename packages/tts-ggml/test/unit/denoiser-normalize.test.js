'use strict'

const test = require('brittle')
const {
  normalizeDenoiser,
  denoiserTag,
  VALID_DENOISERS,
  DEFAULT_DENOISER
} = require('../utils/downloadModel')

test('normalizeDenoiser accepts the known denoiser axis values', (t) => {
  t.is(normalizeDenoiser('none'), 'none', 'none -> none')
  t.is(normalizeDenoiser('lavasr'), 'lavasr', 'lavasr -> lavasr')
  t.is(normalizeDenoiser('LavaSR'), 'lavasr', 'case-insensitive')
})

test('normalizeDenoiser defaults empty / unset input to the shared default', (t) => {
  t.is(DEFAULT_DENOISER, 'none', 'default denoiser is none (denoiser stage off)')
  t.ok(VALID_DENOISERS.includes('lavasr'), 'lavasr is a valid denoiser')
  t.is(normalizeDenoiser(''), DEFAULT_DENOISER, "'' -> default")
  t.is(normalizeDenoiser('  '), DEFAULT_DENOISER, 'whitespace-only -> default (not an error)')
  t.is(normalizeDenoiser(undefined), DEFAULT_DENOISER, 'undefined -> default')
  t.is(normalizeDenoiser(null), DEFAULT_DENOISER, 'null -> default')
})

test('normalizeDenoiser trims surrounding whitespace before validating', (t) => {
  t.is(normalizeDenoiser('  lavasr  '), 'lavasr', 'a padded value is trimmed, not rejected')
  t.is(normalizeDenoiser(' none '), 'none', 'a padded default value is trimmed')
})

test('normalizeDenoiser throws on an unknown denoiser so a typo fails loudly', (t) => {
  t.exception(
    () => normalizeDenoiser('lavasr-typo'),
    /Invalid benchmark denoiser/,
    'unknown denoiser is rejected instead of silently disabling denoising'
  )
})

test('denoiserTag emits the fixed denoise token only for a non-default denoiser', (t) => {
  t.is(denoiserTag('lavasr'), 'denoise', 'lavasr -> denoise token (never the axis value)')
  t.is(denoiserTag('LavaSR'), 'denoise', 'token is stable (case-insensitive)')
})

test('denoiserTag is empty for the default so pre-axis artifacts stay byte-stable', (t) => {
  t.is(denoiserTag('none'), '', 'none -> no token')
  t.is(denoiserTag(''), '', "'' -> no token")
  t.is(denoiserTag(undefined), '', 'undefined -> no token')
  t.is(denoiserTag(null), '', 'null -> no token')
})

test('denoiserTag stays distinct from the enhancer token when both axes are on', (t) => {
  const { enhancerTag } = require('../utils/downloadModel')
  t.not(denoiserTag('lavasr'), enhancerTag('lavasr'), 'denoise token != lavasr token')
})

test('denoiserTag throws on an unknown denoiser so a typo fails loudly', (t) => {
  t.exception(
    () => denoiserTag('lavasr-typo'),
    /Invalid benchmark denoiser/,
    'an invalid denoiser cannot silently produce a bogus artifact tag'
  )
})
