'use strict'

const test = require('brittle')
const { normalizeName } = require('../../addon.js')

test('normalizeName returns "world" for null', (t) => {
  t.is(normalizeName(null), 'world')
})

test('normalizeName returns "world" for undefined', (t) => {
  t.is(normalizeName(undefined), 'world')
})

test('normalizeName returns "world" for empty string', (t) => {
  t.is(normalizeName(''), 'world')
})

test('normalizeName returns the input when non-empty string', (t) => {
  t.is(normalizeName('qvac'), 'qvac')
})

test('normalizeName coerces numbers to strings', (t) => {
  t.is(normalizeName(42), '42')
})
