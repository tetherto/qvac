'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  DEFAULT_OVERLAP,
  EU_LANGUAGES,
  NO_CONTEXT_FRAMES,
  describeCoremlRouting,
  longFormFramesFor,
  parakeetConfigFor,
  parseLongFormArguments
} = require('../../examples/parakeet-long-form-arguments.js')

const TRANSCRIBEPSY_WINDOW_FRAMES = 750
const TRANSCRIBEPSY_CONTEXT_FRAMES = 94

test('the TranscribePsy example parses its model, audio and window flags', () => {
  assert.deepEqual(
    parseLongFormArguments([
      '-m',
      'm.gguf',
      '--audio',
      'a.wav',
      '--window-sec',
      '30',
      '--overlap',
      '0.1'
    ]),
    { model: 'm.gguf', audio: 'a.wav', windowSeconds: 30, overlap: 0.1, language: null }
  )
})

test('without a window flag the example leaves the window to the model', () => {
  const args = parseLongFormArguments(['--model', 'm.gguf', '--audio', 'a.wav'])
  assert.equal(args.windowSeconds, null)
  assert.equal(args.overlap, DEFAULT_OVERLAP)
  assert.deepEqual(longFormFramesFor(args.windowSeconds, args.overlap), {})
})

test('60 s with 25 % overlap are the frame counts TranscribePsy recommends', () => {
  assert.deepEqual(longFormFramesFor(60, 0.25), {
    longFormWindowFrames: TRANSCRIBEPSY_WINDOW_FRAMES,
    longFormContextFrames: TRANSCRIBEPSY_CONTEXT_FRAMES
  })
})

test('an explicit zero overlap sends the no-context sentinel, not the automatic 0', () => {
  assert.equal(NO_CONTEXT_FRAMES, -1)
  assert.deepEqual(longFormFramesFor(60, 0), {
    longFormWindowFrames: TRANSCRIBEPSY_WINDOW_FRAMES,
    longFormContextFrames: NO_CONTEXT_FRAMES
  })
})

test('an overlap that rounds to no frames is sent as no context as well', () => {
  assert.deepEqual(longFormFramesFor(1, 0.01), {
    longFormWindowFrames: 13,
    longFormContextFrames: NO_CONTEXT_FRAMES
  })
  assert.deepEqual(longFormFramesFor(1, 0.1), {
    longFormWindowFrames: 13,
    longFormContextFrames: 1
  })
})

test('the example rejects windows, overlaps and flags the engine would not take', () => {
  assert.throws(() => parseLongFormArguments(['--window-sec', '0']), /--window-sec expects/)
  assert.throws(() => parseLongFormArguments(['--window-sec', 'soon']), /--window-sec expects/)
  assert.throws(() => parseLongFormArguments(['--overlap', '0.6']), /--overlap expects/)
  assert.throws(() => parseLongFormArguments(['--overlap', '-0.1']), /--overlap expects/)
  assert.throws(() => parseLongFormArguments(['--lang', 'en']), /Unknown argument/)
})

test('the example takes the three routes of the full TranscribePsy EU model', () => {
  assert.deepEqual(EU_LANGUAGES, ['auto', 'en', 'other'])
  for (const language of EU_LANGUAGES) {
    assert.equal(parseLongFormArguments(['--language', language]).language, language)
  }
})

test('the example rejects a language the full EU model has no route for', () => {
  assert.throws(() => parseLongFormArguments(['--language', 'fr']), /--language expects/)
  assert.throws(() => parseLongFormArguments(['--language', 'EN']), /--language expects/)
  assert.throws(() => parseLongFormArguments(['--language']), /--language expects/)
})

test('an EU-sub run sends no language, a full EU run sends its route', () => {
  const euSub = parseLongFormArguments(['-m', 'm.gguf', '-a', 'a.wav'])
  assert.deepEqual(parakeetConfigFor(euSub), {})

  const fullEu = parseLongFormArguments(['--language', 'other', '--window-sec', '60'])
  assert.deepEqual(parakeetConfigFor(fullEu), {
    longFormWindowFrames: TRANSCRIBEPSY_WINDOW_FRAMES,
    longFormContextFrames: TRANSCRIBEPSY_CONTEXT_FRAMES,
    language: 'other'
  })
})

test('the Core ML report names what the job used, not only what loaded', () => {
  const loaded = { encoderOnCoreml: true, encoderBackend: 'coreml', backendName: 'Metal' }
  assert.deepEqual(describeCoremlRouting(loaded, { encoderUsedCoreml: 1, decoderUsedCoreml: 1 }), [
    'Encoder: Core ML',
    'Every window on Core ML: yes',
    'Decoder on Core ML: yes'
  ])
  assert.deepEqual(describeCoremlRouting(loaded, { encoderUsedCoreml: 0, decoderUsedCoreml: 0 }), [
    'Encoder: Core ML',
    'Every window on Core ML: no',
    'Decoder on Core ML: no'
  ])
})

test('the Core ML report leaves out statistics the job did not produce', () => {
  const ggml = { encoderOnCoreml: false, encoderBackend: 'Metal', backendName: 'Metal' }
  assert.deepEqual(describeCoremlRouting(ggml, { encoderUsedCoreml: 0 }), [
    'Encoder: Metal',
    'Every window on Core ML: no'
  ])
  assert.deepEqual(describeCoremlRouting(ggml, undefined), ['Encoder: Metal'])
  assert.deepEqual(describeCoremlRouting({ encoderOnCoreml: false, backendName: 'CPU' }, null), [
    'Encoder: CPU'
  ])
})
