'use strict'

const test = require('brittle')
const {
  normalizeEnhancerVariant,
  enhancerVariantTag,
  lavasrEnhancerGguf,
  VALID_ENHANCER_VARIANTS,
  DEFAULT_ENHANCER_VARIANT
} = require('../utils/downloadModel')

test('normalizeEnhancerVariant returns the canonical tier for every known value', (t) => {
  for (const tier of VALID_ENHANCER_VARIANTS) {
    t.is(normalizeEnhancerVariant(tier), tier, `${tier} -> ${tier}`)
  }
})

test('normalizeEnhancerVariant is case-insensitive and canonicalizes casing', (t) => {
  t.is(normalizeEnhancerVariant('Q8_0'), 'q8_0', 'block quant lowercases')
  t.is(normalizeEnhancerVariant('F16'), 'f16', 'fp16 tier lowercases')
  t.is(normalizeEnhancerVariant('F32'), 'f32', 'fp32 tier lowercases')
})

test('normalizeEnhancerVariant defaults empty / unset input to fp16', (t) => {
  t.is(DEFAULT_ENHANCER_VARIANT, 'f16', 'default enhancer tier is fp16')
  t.is(normalizeEnhancerVariant(''), DEFAULT_ENHANCER_VARIANT, "'' -> default")
  t.is(normalizeEnhancerVariant('  '), DEFAULT_ENHANCER_VARIANT, 'whitespace -> default')
  t.is(normalizeEnhancerVariant(undefined), DEFAULT_ENHANCER_VARIANT, 'undefined -> default')
  t.is(normalizeEnhancerVariant(null), DEFAULT_ENHANCER_VARIANT, 'null -> default')
})

test('normalizeEnhancerVariant throws on an unsupported tier so a typo fails loudly', (t) => {
  t.exception(
    () => normalizeEnhancerVariant('q3_0'),
    /Invalid LavaSR enhancer variant/,
    'an unsupported tier is rejected instead of silently downgrading to fp16'
  )
  t.exception(
    () => normalizeEnhancerVariant('q4_K'),
    /Invalid LavaSR enhancer variant/,
    'a tier outside the supported f16/f32/q8_0 set is rejected'
  )
})

test('lavasrEnhancerGguf keeps the historical on-disk name for the fp16 default', (t) => {
  const gguf = lavasrEnhancerGguf('f16')
  t.is(gguf.name, 'lavasr-enhancer.gguf', 'fp16 stays byte-stable on disk')
  t.ok(
    gguf.registryPath.endsWith('/lavasr-enhancer-f16.gguf'),
    'registry filename still carries the tier suffix'
  )
})

test('lavasrEnhancerGguf gives each non-default tier its own coexisting file', (t) => {
  const gguf = lavasrEnhancerGguf('q8_0')
  t.is(gguf.name, 'lavasr-enhancer-q8_0.gguf', 'quant tier lives at its own on-disk name')
  t.ok(
    gguf.registryPath.endsWith('/lavasr-enhancer-q8_0.gguf'),
    'registry path targets the tier GGUF'
  )
  t.ok(gguf.registrySource, 'a registry source is set so the fetch can resolve')
})

test('lavasrEnhancerGguf canonicalizes the tier before building the descriptor', (t) => {
  const gguf = lavasrEnhancerGguf('Q8_0')
  t.is(gguf.name, 'lavasr-enhancer-q8_0.gguf', 'the tier casing is canonical')
  t.ok(gguf.registryPath.endsWith('/lavasr-enhancer-q8_0.gguf'), 'registry path matches')
})

test('enhancerVariantTag is empty for the fp16 default so artifacts stay byte-stable', (t) => {
  t.is(enhancerVariantTag('lavasr', 'f16'), '', 'lavasr + fp16 -> no tier token')
  t.is(enhancerVariantTag('lavasr', ''), '', 'lavasr + unset -> no tier token')
  t.is(enhancerVariantTag('lavasr', undefined), '', 'lavasr + undefined -> no tier token')
})

test('enhancerVariantTag emits the canonical tier for a non-default quant', (t) => {
  t.is(enhancerVariantTag('lavasr', 'q8_0'), 'q8_0', 'lavasr + q8_0 -> q8_0 token')
  t.is(enhancerVariantTag('lavasr', 'Q8_0'), 'q8_0', 'token is canonicalized')
  t.is(enhancerVariantTag('lavasr', 'f32'), 'f32', 'lavasr + f32 -> f32 token')
})

test('enhancerVariantTag is inert when the enhancer is off, regardless of tier', (t) => {
  t.is(enhancerVariantTag('none', 'q8_0'), '', 'no enhancer -> no tier token even for a quant')
  t.is(enhancerVariantTag('', 'f32'), '', "'' enhancer -> no tier token")
  t.is(enhancerVariantTag(undefined, 'q8_0'), '', 'undefined enhancer -> no tier token')
})
