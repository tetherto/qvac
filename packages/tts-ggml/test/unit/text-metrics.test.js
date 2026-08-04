'use strict'

const test = require('brittle')
const {
  normalizeText,
  levenshtein,
  wordErrorRate,
  characterErrorRate
} = require('../utils/textMetrics')

test('text metrics normalize punctuation and word separators', (t) => {
  t.is(normalizeText('  Hello—world, it’s me!  '), 'hello world it s me')
})

test('text metrics compute Levenshtein distance', (t) => {
  t.is(levenshtein('kitten', 'sitting'), 3)
})

test('text metrics compute order-sensitive WER', (t) => {
  t.is(wordErrorRate('the quick brown fox', 'the slow brown fox'), 0.25)
  t.is(wordErrorRate('hello, world!', 'hello world'), 0)
})

test('text metrics compute Unicode-aware CER', (t) => {
  t.is(characterErrorRate('café', 'cafe'), 0.25)
  t.is(characterErrorRate('hello', 'hello'), 0)
})

test('text metrics handle empty references', (t) => {
  t.is(wordErrorRate('', ''), 0)
  t.is(wordErrorRate('', 'extra'), 1)
  t.is(characterErrorRate('', ''), 0)
  t.is(characterErrorRate('', 'extra'), 1)
})
