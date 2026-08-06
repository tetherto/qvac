'use strict'

const test = require('brittle')
const {
  normalizeEnhancer,
  enhancerTag,
  VALID_ENHANCERS,
  DEFAULT_ENHANCER
} = require('../utils/downloadModel')

test('normalizeEnhancer accepts the known enhancer axis values', (t) => {
  t.is(normalizeEnhancer('none'), 'none', 'none -> none')
  t.is(normalizeEnhancer('lavasr'), 'lavasr', 'lavasr -> lavasr')
  t.is(normalizeEnhancer('LavaSR'), 'lavasr', 'case-insensitive')
})

test('normalizeEnhancer defaults empty / unset input to the shared default', (t) => {
  t.is(DEFAULT_ENHANCER, 'none', 'default enhancer is none (engine as-is)')
  t.ok(VALID_ENHANCERS.includes('lavasr'), 'lavasr is a valid enhancer')
  t.is(normalizeEnhancer(''), DEFAULT_ENHANCER, "'' -> default")
  t.is(normalizeEnhancer('  '), DEFAULT_ENHANCER, 'whitespace-only -> default (not an error)')
  t.is(normalizeEnhancer(undefined), DEFAULT_ENHANCER, 'undefined -> default')
  t.is(normalizeEnhancer(null), DEFAULT_ENHANCER, 'null -> default')
})

test('normalizeEnhancer trims surrounding whitespace before validating', (t) => {
  t.is(normalizeEnhancer('  lavasr  '), 'lavasr', 'a padded value is trimmed, not rejected')
  t.is(normalizeEnhancer(' none '), 'none', 'a padded default value is trimmed')
})

test('normalizeEnhancer throws on an unknown enhancer so a typo fails loudly', (t) => {
  t.exception(
    () => normalizeEnhancer('lavasr-typo'),
    /Invalid benchmark enhancer/,
    'unknown enhancer is rejected instead of silently disabling enhancement'
  )
})

test('enhancerTag emits a token only for a non-default enhancer', (t) => {
  t.is(enhancerTag('lavasr'), 'lavasr', 'lavasr -> lavasr token')
  t.is(enhancerTag('LavaSR'), 'lavasr', 'token is normalized (case-insensitive)')
})

test('enhancerTag is empty for the default so pre-axis artifacts stay byte-stable', (t) => {
  t.is(enhancerTag('none'), '', 'none -> no token')
  t.is(enhancerTag(''), '', "'' -> no token")
  t.is(enhancerTag(undefined), '', 'undefined -> no token')
  t.is(enhancerTag(null), '', 'null -> no token')
})

test('enhancerTag throws on an unknown enhancer so a typo fails loudly', (t) => {
  t.exception(
    () => enhancerTag('lavasr-typo'),
    /Invalid benchmark enhancer/,
    'an invalid enhancer cannot silently produce a bogus artifact tag'
  )
})
