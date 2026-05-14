'use strict'

const test = require('brittle')
const { computeWER } = require('../../lib/wer')

test('[wer] identical text returns 0', (t) => {
  t.is(computeWER('hello world', 'hello world'), 0)
})

test('[wer] completely different text returns 1', (t) => {
  t.is(computeWER('foo bar', 'baz qux'), 1)
})

test('[wer] one insertion returns 1.0 (WER is normalized by reference length)', (t) => {
  t.is(computeWER('hello world', 'hello'), 1)
})

test('[wer] one deletion returns 0.5', (t) => {
  t.is(computeWER('hello', 'hello world'), 0.5)
})

test('[wer] one substitution returns 0.5', (t) => {
  t.is(computeWER('hello world', 'hello foo'), 0.5)
})

test('[wer] punctuation differences should not inflate error rate', (t) => {
  // The stitcher normalizes words by stripping punctuation, so WER should
  // do the same to produce consistent evaluation results.
  // Bug: computeWER currently counts "Hello," and "hello" as different words
  const wer1 = computeWER('Hello, World!', 'hello world')
  t.ok(wer1 < 0.5, `WER with punctuation should be low, got ${wer1}`)

  const wer2 = computeWER("Don't stop!", "don't stop")
  t.ok(wer2 < 0.5, `WER with apostrophe should be low, got ${wer2}`)
})

test('[wer] case differences should not affect result', (t) => {
  t.is(computeWER('HELLO WORLD', 'hello world'), 0)
})

test('[wer] extra whitespace should not affect result', (t) => {
  t.is(computeWER('  hello   world  ', 'hello world'), 0)
})

test('[wer] empty inputs', (t) => {
  t.is(computeWER('', ''), 0)
  t.is(computeWER('hello', ''), 1)
  t.is(computeWER('', 'hello'), 1)
})
