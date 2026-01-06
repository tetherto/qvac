/**
 * Tests for MosesPunctNormalizer
 */

const test = require('brittle')
const {
  MosesPunctNormalizer
} = require('../../third-party/indic-processor-deps/sacremoses')

test('MosesPunctNormalizer should normalize documents correctly', (t) => {
  const moses = new MosesPunctNormalizer()
  // Examples from normalizing big.txt
  const inputs = [
    'The United States in 1805 (color map)                 _Facing_     193',
    '=Formation of the Constitution.=--(1) The plans before the convention,',
    'directions--(1) The infective element must be eliminated. When the ulcer',
    'College of Surgeons, Edinburgh.)]'
  ]
  const expected = [
    'The United States in 1805 (color map) _Facing_ 193',
    '=Formation of the Constitution.=-- (1) The plans before the convention,',
    'directions-- (1) The infective element must be eliminated. When the ulcer',
    'College of Surgeons, Edinburgh.) ]'
  ]

  for (let i = 0; i < inputs.length; i++) {
    t.is(moses.normalize(inputs[i]), expected[i])
  }
})

test('MosesPunctNormalizer should handle quote comma normalization correctly', (t) => {
  const mosesNormQuote = new MosesPunctNormalizer('en', {
    normQuoteCommas: true
  })
  const mosesNoNormQuote = new MosesPunctNormalizer('en', {
    normQuoteCommas: false
  })
  const text = 'THIS EBOOK IS OTHERWISE PROVIDED TO YOU "AS-IS".'

  const expectedNormQuote = 'THIS EBOOK IS OTHERWISE PROVIDED TO YOU "AS-IS."'
  t.is(mosesNormQuote.normalize(text), expectedNormQuote)

  const expectedNoNormQuote =
    'THIS EBOOK IS OTHERWISE PROVIDED TO YOU "AS-IS".'
  const result = mosesNoNormQuote.normalize(text)
  console.log(result, expectedNoNormQuote)
  t.is(mosesNoNormQuote.normalize(text), expectedNoNormQuote)
})

test('MosesPunctNormalizer should normalize numbers correctly', (t) => {
  // See https://stackoverflow.com/a/55233871/610569
  const mosesNormNum = new MosesPunctNormalizer('en', { normNumbers: true })
  const mosesNoNormNum = new MosesPunctNormalizer('en', { normNumbers: false })

  let text = `12${'\u00A0'}123` // Non-breaking space
  let expected = '12.123'
  t.is(mosesNormNum.normalize(text), expected)

  text = expected = '12 123'
  t.is(mosesNoNormNum.normalize(text), expected)
})

test('MosesPunctNormalizer should normalize single apostrophe correctly', (t) => {
  const mosesNormNum = new MosesPunctNormalizer('en')
  const text = "yesterday 's reception"
  const expected = "yesterday 's reception"
  t.is(mosesNormNum.normalize(text), expected)
})

test('MosesPunctNormalizer should replace unicode punctuation correctly', (t) => {
  const mosesNormUnicode = new MosesPunctNormalizer()
  const text = '０《１２３》 ４５６％ 【７８９】'
  const expected = '0"123" 456% [789]'
  t.is(mosesNormUnicode.replaceUnicodePunct(text), expected)
})

test('MosesPunctNormalizer should handle normalization pipeline correctly', (t) => {
  const mosesNormUnicode = new MosesPunctNormalizer('en', {
    preReplaceUnicodePunct: true,
    postRemoveControlChars: true
  })
  const text = "０《１２３》      ４５６％  '' 【７８９】"
  const expected = '0"123" 456% " [789]'
  console.log(mosesNormUnicode.normalize(text), expected)
  t.is(mosesNormUnicode.normalize(text), expected)
})
