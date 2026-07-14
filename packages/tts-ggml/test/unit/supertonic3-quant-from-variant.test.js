'use strict'

const test = require('brittle')
const { supertonic3QuantFromVariant, DEFAULT_SUPERTONIC3_QUANT } = require('../utils/downloadModel')

test('supertonic3QuantFromVariant maps known variant labels to tiers', (t) => {
  t.is(supertonic3QuantFromVariant('q4'), 'q4_0', 'q4 -> q4_0')
  t.is(supertonic3QuantFromVariant('q8'), 'q8_0', 'q8 -> q8_0')
  t.is(supertonic3QuantFromVariant('f16'), 'f16', 'f16 -> f16')
})

test('supertonic3QuantFromVariant falls back to the shared default for unknown labels', (t) => {
  t.is(DEFAULT_SUPERTONIC3_QUANT, 'q4_0', 'default tier is q4_0 (CI / mobile tier)')
  t.is(supertonic3QuantFromVariant('mixed'), DEFAULT_SUPERTONIC3_QUANT, 'mixed -> default')
  t.is(supertonic3QuantFromVariant('bogus'), DEFAULT_SUPERTONIC3_QUANT, 'unknown -> default')
  t.is(supertonic3QuantFromVariant(undefined), DEFAULT_SUPERTONIC3_QUANT, 'undefined -> default')
})
