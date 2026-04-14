'use strict'

const test = require('brittle')
const {
  splitTtsText,
  intlSentenceSegmentationAvailable,
  splitByAsciiAndCjkPunctuation
} = require('../../lib/textChunker.js')

test('splitByAsciiAndCjkPunctuation splits on CJK full stops', (t) => {
  const parts = splitByAsciiAndCjkPunctuation('第一句。第二句。')
  t.is(parts.length, 2)
  t.ok(parts[0].includes('一'))
  t.ok(parts[1].includes('二'))
})

test('splitTtsText respects max length for long unbroken text', (t) => {
  const long = 'x'.repeat(500)
  const chunks = splitTtsText(long, { language: 'en', maxScalars: 300 })
  t.ok(chunks.length >= 2)
  for (const c of chunks) {
    t.ok([...c].length <= 300)
  }
})

test('splitTtsText uses shorter chunks for Korean default', (t) => {
  const body = '가'.repeat(200)
  const chunks = splitTtsText(body, { language: 'ko' })
  t.ok(chunks.length >= 2)
})

test('intlSentenceSegmentationAvailable is boolean', (t) => {
  t.is(typeof intlSentenceSegmentationAvailable(), 'boolean')
})

test('splitTtsText mergeToMaxScalars:false does not merge sentences by max length', (t) => {
  const text = 'A. B. C. D. E.'
  const sentenceLevel = splitTtsText(text, { language: 'en', mergeToMaxScalars: false })
  const merged = splitTtsText(text, { language: 'en', mergeToMaxScalars: true, maxScalars: 100 })
  t.ok(sentenceLevel.length >= merged.length)
})
