'use strict'

const test = require('brittle')
const {
  isEnhancerVariantPublished,
  classifyEnhancerResolution,
  classifyDenoiserResolution,
  PUBLISHED_ENHANCER_VARIANTS,
  VALID_ENHANCER_VARIANTS,
  DEFAULT_ENHANCER_VARIANT
} = require('../utils/downloadModel')

test('the published tier set is a subset of the valid tiers', (t) => {
  for (const tier of PUBLISHED_ENHANCER_VARIANTS) {
    t.ok(VALID_ENHANCER_VARIANTS.includes(tier), `${tier} is a valid tier`)
  }
})

test('isEnhancerVariantPublished flags fp16/fp32 as published and q8_0 as not', (t) => {
  t.ok(isEnhancerVariantPublished('f16'), 'fp16 is on S3')
  t.ok(isEnhancerVariantPublished('f32'), 'fp32 is on S3')
  t.absent(isEnhancerVariantPublished('q8_0'), 'q8_0 is not on S3 yet')
})

test('isEnhancerVariantPublished treats the unset default (fp16) as published', (t) => {
  t.is(DEFAULT_ENHANCER_VARIANT, 'f16', 'default tier is fp16')
  t.ok(isEnhancerVariantPublished(''), "'' -> default fp16 -> published")
  t.ok(isEnhancerVariantPublished(undefined), 'undefined -> default fp16 -> published')
})

test('isEnhancerVariantPublished canonicalizes casing before deciding', (t) => {
  t.ok(isEnhancerVariantPublished('F16'), 'F16 -> published')
  t.absent(isEnhancerVariantPublished('Q8_0'), 'Q8_0 -> not published')
})

test('classifyEnhancerResolution returns the staged path on a successful fetch', (t) => {
  const outcome = classifyEnhancerResolution(
    { success: true, path: '/models/lavasr/e.gguf' },
    'q8_0'
  )
  t.is(outcome.path, '/models/lavasr/e.gguf', 'the fetched path is surfaced')
  t.absent(outcome.fail, 'a success is not a failure')
  t.absent(outcome.skip, 'a success is not a skip')
})

test('classifyEnhancerResolution hard-fails a published tier that could not be fetched', (t) => {
  for (const tier of ['f16', 'f32']) {
    const outcome = classifyEnhancerResolution({ success: false }, tier)
    t.ok(outcome.fail, `${tier} fetch failure is a hard error`)
    t.absent(outcome.skip, `${tier} does not soft-skip`)
    t.ok(/published/.test(outcome.reason), 'the reason explains it is published')
  }
})

test('classifyEnhancerResolution hard-fails the unset default (fp16) too', (t) => {
  const outcome = classifyEnhancerResolution({ success: false }, undefined)
  t.ok(outcome.fail, 'the default fp16 tier is published, so a failure is red')
})

test('classifyEnhancerResolution soft-skips a not-yet-published tier', (t) => {
  const outcome = classifyEnhancerResolution({ success: false }, 'q8_0')
  t.ok(outcome.skip, 'q8_0 fetch failure is an expected soft-skip')
  t.absent(outcome.fail, 'q8_0 does not hard-fail')
  t.ok(/not published/.test(outcome.reason), 'the reason explains it is not on S3 yet')
})

test('classifyEnhancerResolution canonicalizes the tier before deciding', (t) => {
  t.ok(classifyEnhancerResolution({ success: false }, 'F32').fail, 'F32 -> published -> fail')
  t.ok(classifyEnhancerResolution({ success: false }, 'Q8_0').skip, 'Q8_0 -> unpublished -> skip')
})

test('classifyDenoiserResolution returns the path on success and hard-fails otherwise', (t) => {
  const ok = classifyDenoiserResolution({ success: true, path: '/models/lavasr/d.gguf' })
  t.is(ok.path, '/models/lavasr/d.gguf', 'a fetched denoiser path is surfaced')

  const bad = classifyDenoiserResolution({ success: false })
  t.ok(bad.fail, 'the denoiser is published, so a fetch failure is red')
  t.absent(bad.skip, 'the denoiser never soft-skips')
  t.ok(/published/.test(bad.reason), 'the reason explains it is published')
})
