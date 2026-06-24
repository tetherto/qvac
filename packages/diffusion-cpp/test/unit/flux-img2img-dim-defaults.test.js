'use strict'

const test = require('brittle')
const { applyFluxImg2ImgDimDefaults } = require('../../index.js')

const FLUX_PRED = 'flux2_flow'
const SD_PRED = 'v'
const BASE_PARAMS = { prompt: 'test', init_image: new Uint8Array([1, 2, 3]) }

test('both axes omitted — defaults to 1024x1024 for FLUX img2img', function (t) {
  const result = applyFluxImg2ImgDimDefaults(BASE_PARAMS, FLUX_PRED, false)
  t.is(result.width, 1024)
  t.is(result.height, 1024)
})

test('width omitted — defaults width to 1024, preserves explicit height', function (t) {
  const params = { ...BASE_PARAMS, height: 768 }
  const result = applyFluxImg2ImgDimDefaults(params, FLUX_PRED, false)
  t.is(result.width, 1024)
  t.is(result.height, 768)
})

test('height omitted — defaults height to 1024, preserves explicit width', function (t) {
  const params = { ...BASE_PARAMS, width: 768 }
  const result = applyFluxImg2ImgDimDefaults(params, FLUX_PRED, false)
  t.is(result.width, 768)
  t.is(result.height, 1024)
})

test('fusion path (init_images) with both axes omitted — defaults to 1024x1024', function (t) {
  const params = { prompt: 'test' }
  const result = applyFluxImg2ImgDimDefaults(params, FLUX_PRED, true)
  t.is(result.width, 1024)
  t.is(result.height, 1024)
})

test('non-FLUX prediction — params returned unchanged', function (t) {
  const result = applyFluxImg2ImgDimDefaults(BASE_PARAMS, SD_PRED, false)
  t.absent(result.width)
  t.absent(result.height)
})

test('both axes explicit — params returned unchanged', function (t) {
  const params = { ...BASE_PARAMS, width: 512, height: 512 }
  const result = applyFluxImg2ImgDimDefaults(params, FLUX_PRED, false)
  t.is(result.width, 512)
  t.is(result.height, 512)
})
