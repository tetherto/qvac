import type { TestDefinition } from '@tetherto/qvac-test-suite'

export const ttsChatterboxShortText: TestDefinition = {
  testId: 'tts-chatterbox-short-text',
  params: { text: 'Hello, how are you today?', stream: false },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: { category: 'tts', dependency: 'tts-chatterbox', estimatedDurationMs: 200000 }
}

export const ttsChatterboxMediumText: TestDefinition = {
  testId: 'tts-chatterbox-medium-text',
  params: {
    text: 'This is a test of the Chatterbox Text-to-Speech engine. It should generate high quality audio from this medium length text input.',
    stream: false
  },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'tts', dependency: 'tts-chatterbox', estimatedDurationMs: 45000 }
}

export const ttsChatterboxStreaming: TestDefinition = {
  testId: 'tts-chatterbox-streaming',
  params: { text: 'This is a streaming test for the Chatterbox engine.', stream: true },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'tts', dependency: 'tts-chatterbox', estimatedDurationMs: 45000 }
}

export const ttsChatterboxEmptyTextError: TestDefinition = {
  testId: 'tts-chatterbox-empty-text-error',
  params: { text: '', stream: false },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'tts', dependency: 'tts-chatterbox', estimatedDurationMs: 10000 }
}

export const ttsSupertonicShortText: TestDefinition = {
  testId: 'tts-supertonic-short-text',
  params: { text: 'Hello, how are you today?', stream: false },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'tts', dependency: 'tts-supertonic', estimatedDurationMs: 30000 }
}

export const ttsSupertonicMediumText: TestDefinition = {
  testId: 'tts-supertonic-medium-text',
  params: {
    text: 'This is a test of the Supertonic Text-to-Speech engine. It should generate high quality audio from this medium length text input.',
    stream: false
  },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'tts', dependency: 'tts-supertonic', estimatedDurationMs: 45000 }
}

export const ttsSupertonicStreaming: TestDefinition = {
  testId: 'tts-supertonic-streaming',
  params: { text: 'This is a streaming test for the Supertonic engine.', stream: true },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: { category: 'tts', dependency: 'tts-supertonic', estimatedDurationMs: 45000 }
}

export const ttsSupertonicEmptyTextError: TestDefinition = {
  testId: 'tts-supertonic-empty-text-error',
  params: { text: '', stream: false },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'tts', dependency: 'tts-supertonic', estimatedDurationMs: 10000 }
}

export const ttsSupertonicMultilingualText: TestDefinition = {
  testId: 'tts-supertonic-multilingual-text',
  params: {
    text: 'Hola mundo. Esta es una demostración de síntesis de voz con Supertonic en español.',
    stream: false
  },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: {
    category: 'tts',
    dependency: 'tts-supertonic-multilingual',
    estimatedDurationMs: 45000
  }
}

export const ttsSupertonicSentenceStream: TestDefinition = {
  testId: 'tts-supertonic-sentence-stream',
  params: {
    text: 'This is the first sentence. Here comes the second one. And a third to close it out.',
    stream: true,
    sentenceStream: true
  },
  // `sentence-streamed` is only emitted by the executor's happy path; the
  // zero-chunk regression branch returns "produced no audio" and fails the
  // contains-all match. This catches zero-chunk / empty-buffer regressions
  // that a bare `expectedType: "string"` expectation would let through.
  expectation: { validation: 'contains-all', contains: ['sentence-streamed', 'chunks', 'samples'] },
  metadata: { category: 'tts', dependency: 'tts-supertonic', estimatedDurationMs: 45000 }
}

// LavaSR outputSampleRate: proves the runtime `outputSampleRate` config actually
// resamples end to end. Runs the same text through the native-rate Supertonic
// (44.1 kHz) and an 8 kHz resource; sample count scales with the rate, so the
// native run must produce far more samples (~5.5x). The executor gates on the
// ratio and only emits `outputSampleRate-verified` on the happy path. The SDK's
// public TTS result exposes only the PCM buffer (no sampleRate/stats), so a
// relative sample-count comparison is the strongest available assertion.
export const ttsSupertonicOutputSampleRate: TestDefinition = {
  testId: 'tts-supertonic-output-sample-rate',
  params: {
    text: 'This is a test of the output sample rate configuration for speech synthesis.',
    stream: false
  },
  expectation: {
    validation: 'contains-all',
    contains: ['outputSampleRate-verified', 'samples']
  },
  metadata: {
    category: 'tts',
    dependency: 'tts-supertonic+tts-supertonic-8k',
    estimatedDurationMs: 90000
  }
}

// LavaSR denoiser + enhancer: proves the two-stage LavaSR chain wires up,
// downloads its GGUFs, and produces valid audio end to end. The enhancer forces
// 48 kHz internally, but that rate isn't observable through the public TTS
// result, so this asserts a non-empty buffer (the executor fails on 0 samples).
export const ttsSupertonicEnhanced: TestDefinition = {
  testId: 'tts-supertonic-enhanced',
  params: {
    text: 'This is a test of the LavaSR speech enhancer and denoiser.',
    stream: false
  },
  expectation: { validation: 'contains-all', contains: ['enhanced', 'samples'] },
  metadata: {
    category: 'tts',
    dependency: 'tts-supertonic-enhanced',
    estimatedDurationMs: 60000
  }
}

export const ttsTests = [
  ttsChatterboxShortText,
  ttsChatterboxMediumText,
  ttsChatterboxStreaming,
  ttsChatterboxEmptyTextError,
  ttsSupertonicShortText,
  ttsSupertonicMediumText,
  ttsSupertonicStreaming,
  ttsSupertonicEmptyTextError,
  ttsSupertonicMultilingualText,
  ttsSupertonicSentenceStream,
  ttsSupertonicOutputSampleRate,
  ttsSupertonicEnhanced
]
