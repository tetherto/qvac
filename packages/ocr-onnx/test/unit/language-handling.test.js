'use strict'

const test = require('brittle')
const MockONNXOcr = require('../MockONNXOcr.js')

function createModel () {
  return new MockONNXOcr({
    params: {
      langList: ['en'],
      pathDetector: 'detector.onnx',
      pathRecognizer: 'recognizer_latin.onnx'
    },
    opts: {}
  })
}

// --- Latin languages ---

test('getRecognizerModelName returns latin for English', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['en']), 'latin')
})

test('getRecognizerModelName returns latin for French', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['fr']), 'latin')
})

test('getRecognizerModelName returns latin for Spanish', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['es']), 'latin')
})

test('getRecognizerModelName returns latin for German', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['de']), 'latin')
})

test('getRecognizerModelName returns latin for Portuguese', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['pt']), 'latin')
})

test('getRecognizerModelName returns latin for Italian', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['it']), 'latin')
})

// --- Arabic languages ---

test('getRecognizerModelName returns arabic for Arabic', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['ar']), 'arabic')
})

test('getRecognizerModelName returns arabic for Farsi', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['fa']), 'arabic')
})

test('getRecognizerModelName returns arabic for Uyghur', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['ug']), 'arabic')
})

test('getRecognizerModelName returns arabic for Urdu', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['ur']), 'arabic')
})

// --- Bengali languages ---

test('getRecognizerModelName returns bengali for Bengali', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['bn']), 'bengali')
})

test('getRecognizerModelName returns bengali for Assamese', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['as']), 'bengali')
})

test('getRecognizerModelName returns bengali for Manipuri', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['mni']), 'bengali')
})

// --- Cyrillic languages ---

test('getRecognizerModelName returns cyrillic for Russian', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['ru']), 'cyrillic')
})

test('getRecognizerModelName returns cyrillic for Ukrainian', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['uk']), 'cyrillic')
})

test('getRecognizerModelName returns cyrillic for Bulgarian', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['bg']), 'cyrillic')
})

test('getRecognizerModelName returns cyrillic for Belarusian', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['be']), 'cyrillic')
})

// --- Devanagari languages ---

test('getRecognizerModelName returns devanagari for Hindi', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['hi']), 'devanagari')
})

test('getRecognizerModelName returns devanagari for Marathi', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['mr']), 'devanagari')
})

test('getRecognizerModelName returns devanagari for Nepali', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['ne']), 'devanagari')
})

// --- Edge cases ---

test('getRecognizerModelName defaults to latin for unknown language', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['klingon']), 'latin', 'Unknown language should default to latin')
})

test('getRecognizerModelName defaults to latin for empty list', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName([]), 'latin', 'Empty list should default to latin')
})

test('getRecognizerModelName uses first recognized language in mixed list', async t => {
  const model = createModel()
  // Bengali comes before Arabic in the mock's check order
  t.is(model.getRecognizerModelName(['bn', 'ar']), 'bengali', 'Should use bengali (checked first in mock)')
})

test('getRecognizerModelName handles list with unknown + known language', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['klingon', 'ru']), 'cyrillic', 'Should skip unknown and find cyrillic')
})

test('getRecognizerModelName handles list of all unknown languages', async t => {
  const model = createModel()
  t.is(model.getRecognizerModelName(['klingon', 'elvish', 'dothraki']), 'latin', 'All unknown should default to latin')
})
