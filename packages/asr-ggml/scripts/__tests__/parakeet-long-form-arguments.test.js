'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  DEFAULT_OVERLAP,
  NO_CONTEXT_FRAMES,
  longFormFramesFor,
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
    { model: 'm.gguf', audio: 'a.wav', windowSeconds: 30, overlap: 0.1 }
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
  assert.throws(() => parseLongFormArguments(['--language', 'en']), /Unknown argument/)
})
