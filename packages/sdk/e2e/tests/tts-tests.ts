import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * One synthesis, checked for the audio it produced.
 *
 * The executors validated a sentence they had just written -- "generated N
 * samples" -- against `type: string`. Every string satisfies that, so those
 * tests passed whatever the engine did. The declarative body asks the question
 * they meant: did audio come back.
 */
const ttsSteps = (dependency: string): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  {
    call: {
      method: 'textToSpeech',
      collect: 'pcm',
      params: {
        modelId: '$model',
        text: '$params.text',
        inputType: 'text',
        stream: '$params.stream?',
        sentenceStream: '$params.sentenceStream?'
      },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'pcm', as: 'pcm' } },
  { assert: { on: '$pcm', named: 'producedAudio', with: { minSamples: 1 } } }
]

/**
 * Empty text is refused.
 *
 * The executor accepted either outcome here -- an empty buffer, or a throw
 * whose string it validated as "handled gracefully: <error>" against a
 * `type: string` expectation -- so it passed whatever happened, including a
 * crash message. The SDK does refuse, so that is what this asserts.
 *
 * The refusal's wording is deliberately not asserted. Each client validates
 * against its own schema before anything reaches the engine -- the SDK's own
 * check on JS, pydantic on Python -- and they word it differently. What
 * crosses clients, and what the test is actually about, is that empty text is
 * refused rather than synthesised.
 */
const ttsRefusesEmptyText = (dependency: string): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  {
    callError: {
      method: 'textToSpeech',
      collect: 'pcm',
      params: {
        modelId: '$model',
        text: '$params.text',
        inputType: 'text',
        stream: '$params.stream?'
      },
      as: 'err'
    }
  },
  { project: { from: '$err', path: 'message', as: 'message' } },
  { assert: { on: '$message', named: 'nonEmptyText' } }
]

/**
 * A request refused by schema validation, before any model is involved.
 *
 * These definitions carry `dependency: 'none'` because nothing is loaded: the
 * executor passed the literal `'schema-validation-only'` as the model id, on
 * the grounds that a request this malformed never reaches a model. The body
 * does the same -- `useModel` would fail on a resource key that does not
 * exist, and loading a real model would be asserting something the test is
 * not about.
 */
const ttsRejectsRequest = (): Step[] => [
  {
    callError: {
      method: 'textToSpeech',
      collect: 'pcm',
      params: {
        modelId: 'schema-validation-only',
        text: '$params.text',
        emotion: '$params.emotion?',
        inputType: 'text',
        stream: '$params.stream?'
      },
      as: 'err'
    }
  },
  { project: { from: '$err', path: 'message', as: 'message' } },
  { assert: { on: '$message', use: 'expectation' } }
]

/**
 * Tests whose body compares two runs against each other -- a sample rate
 * against another sample rate, an emotion against the same emotion. One call
 * is not what they are about, so they carry their own bodies below.
 *
 * `tts-supertonic-enhanced` is not among them despite its name: the executor
 * ran one synthesis and checked it produced audio, so it takes the ordinary
 * body.
 */
const TTS_COMPARISONS = new Set([
  'tts-supertonic-output-sample-rate',
  'tts-parler-emotion-conditioning',
  'tts-cosyvoice3-emotion-conditioning'
])

/** One synthesis, conditioned the way the caller asks, bound under `as`. */
const synthesize = (model: string, as: string, extra: Record<string, unknown> = {}): Step[] => [
  {
    call: {
      method: 'textToSpeech',
      collect: 'pcm',
      params: {
        modelId: model,
        text: '$params.text',
        inputType: 'text',
        stream: false,
        ...extra
      },
      as: `${as}Run`
    }
  },
  { project: { from: `$${as}Run`, path: 'pcm', as } }
]

/**
 * Conditioning changed the audio, and only because of the conditioning.
 *
 * Three syntheses: the same request twice, then one with the conditioning
 * changed. The control pair has to come back identical before "this parameter
 * changed the output" means anything -- without it a non-deterministic engine
 * would pass the test by being noisy.
 */
const emotionConditioningSteps = (dependency: string, voice?: string): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  ...synthesize('$model', 'first', {
    emotion: '$params.firstEmotion',
    ...(voice ? { voice: '$params.voice' } : {})
  }),
  ...synthesize('$model', 'control', {
    emotion: '$params.firstEmotion',
    ...(voice ? { voice: '$params.voice' } : {})
  }),
  ...synthesize('$model', 'second', {
    emotion: '$params.secondEmotion',
    ...(voice ? { voice: '$params.voice' } : {})
  }),
  { assert: { on: '$first', named: 'producedAudio', with: { minSamples: 1 } } },
  { assert: { on: '$second', named: 'producedAudio', with: { minSamples: 1 } } },
  { compare: { left: '$first', right: '$control', named: 'identicalBytes' } },
  { compare: { left: '$first', right: '$second', named: 'differentBytes' } }
]

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
  // The two resources are declared together so the eviction guard keeps both
  // for the run; `$models[0]` is the native rate, `$models[1]` the 8 kHz one.
  steps: [
    { useModel: { deps: ['tts-supertonic', 'tts-supertonic-8k'], as: 'models' } },
    ...synthesize('$models[0]', 'native'),
    ...synthesize('$models[1]', 'down'),
    {
      compare: {
        left: '$native',
        right: '$down',
        named: 'lengthRatioAtLeast',
        // Sample count scales with the rate, so 44.1 kHz against 8 kHz is
        // about 5.5x. The 3x floor clears per-load duration jitter while
        // still proving the resample took effect.
        with: { ratio: 3 }
      }
    }
  ],
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

// Parler exposes description-conditioned speech rather than a fixed speaker
// ID. The executor first proves identical prompts and emotions are deterministic,
// then verifies changing only the emotion produces different non-empty PCM.
export const ttsParlerEmotionConditioning: TestDefinition = {
  testId: 'tts-parler-emotion-conditioning',
  steps: emotionConditioningSteps('tts-parler', 'voice'),
  params: {
    text: 'Today is a wonderful day.',
    voice: 'Laura',
    firstEmotion: 'happy',
    secondEmotion: 'sad'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['emotion-conditioning-verified', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-parler', estimatedDurationMs: 180000 }
}

// Omitting all description fields exercises the addon's default Parler
// caption, which is a valid edge case of the public API.
export const ttsParlerDefaultDescription: TestDefinition = {
  testId: 'tts-parler-default-description',
  params: {
    text: 'Hello from Parler.',
    stream: false
  },
  expectation: {
    validation: 'contains-all',
    contains: ['parler-generated', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-parler', estimatedDurationMs: 60000 }
}

export const ttsParlerStreaming: TestDefinition = {
  testId: 'tts-parler-streaming',
  params: {
    text: 'Parler can generate streaming speech.',
    operation: 'stream',
    emotion: 'news'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['parler-generated', 'operation=stream', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-parler', estimatedDurationMs: 90000 }
}

export const ttsParlerSentenceStreaming: TestDefinition = {
  testId: 'tts-parler-sentence-streaming',
  params: {
    text: 'This is the first sentence. This is the second sentence.',
    operation: 'sentence-stream',
    emotion: 'narration'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['parler-generated', 'operation=sentence-stream', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-parler', estimatedDurationMs: 120000 }
}

export const ttsParlerDuplexStreaming: TestDefinition = {
  testId: 'tts-parler-duplex-streaming',
  params: {
    text: 'Parler also supports duplex text streaming.',
    operation: 'duplex',
    emotion: 'conversation'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['parler-generated', 'operation=duplex', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-parler', estimatedDurationMs: 90000 }
}

export const ttsParlerIndicMultilingual: TestDefinition = {
  testId: 'tts-parler-indic-multilingual',
  params: {
    text: 'नमस्ते, आज २७ जुलाई है।',
    operation: 'batch',
    emotion: 'conversation'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['parler-generated', 'operation=batch', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-parler-indic', estimatedDurationMs: 120000 }
}

export const ttsParlerInvalidEmotion: TestDefinition = {
  testId: 'tts-parler-invalid-emotion',
  params: {
    text: 'This request must fail validation.',
    emotion: 'angry',
    stream: false
  },
  expectation: {
    validation: 'throws-error',
    errorContains: 'emotion'
  },
  metadata: { category: 'tts', dependency: 'none', estimatedDurationMs: 1000 }
}

// CosyVoice3 conditions synthesis on a single trained instruction (emotion,
// pace, or instruct). The executor first proves identical prompts and emotions
// are deterministic, then verifies changing only the emotion produces
// different non-empty PCM.
export const ttsCosyvoice3EmotionConditioning: TestDefinition = {
  testId: 'tts-cosyvoice3-emotion-conditioning',
  steps: emotionConditioningSteps('tts-cosyvoice3'),
  params: {
    text: 'Today is a wonderful day.',
    firstEmotion: 'happy',
    secondEmotion: 'sad'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['emotion-conditioning-verified', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-cosyvoice3', estimatedDurationMs: 180000 }
}

// Omitting every conditioning control exercises plain zero-shot synthesis,
// which is a valid edge case of the public API.
export const ttsCosyvoice3Default: TestDefinition = {
  testId: 'tts-cosyvoice3-default',
  params: {
    text: 'Hello from CosyVoice3.',
    stream: false
  },
  expectation: {
    validation: 'contains-all',
    contains: ['cosyvoice3-generated', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-cosyvoice3', estimatedDurationMs: 210000 }
}

export const ttsCosyvoice3Streaming: TestDefinition = {
  testId: 'tts-cosyvoice3-streaming',
  params: {
    text: 'CosyVoice3 can generate streaming speech.',
    operation: 'stream',
    emotion: 'neutral'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['cosyvoice3-generated', 'operation=stream', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-cosyvoice3', estimatedDurationMs: 90000 }
}

// Runs against the native-chunk-streaming resource (streamChunkTokens > 0) so
// the newly exposed native 24 kHz chunk path is exercised, not just the
// generic SDK streaming wrapper used by tts-cosyvoice3-streaming.
export const ttsCosyvoice3NativeStreaming: TestDefinition = {
  testId: 'tts-cosyvoice3-native-streaming',
  params: {
    text: 'CosyVoice3 native chunk streaming emits audio progressively.',
    operation: 'stream'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['cosyvoice3-generated', 'operation=stream', 'samples']
  },
  metadata: {
    category: 'tts',
    dependency: 'tts-cosyvoice3-native-stream',
    estimatedDurationMs: 90000
  }
}

export const ttsCosyvoice3SentenceStreaming: TestDefinition = {
  testId: 'tts-cosyvoice3-sentence-streaming',
  params: {
    text: 'This is the first sentence. This is the second sentence.',
    operation: 'sentence-stream',
    pace: 'fast'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['cosyvoice3-generated', 'operation=sentence-stream', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-cosyvoice3', estimatedDurationMs: 120000 }
}

export const ttsCosyvoice3DuplexStreaming: TestDefinition = {
  testId: 'tts-cosyvoice3-duplex-streaming',
  params: {
    text: 'CosyVoice3 also supports duplex text streaming.',
    operation: 'duplex',
    emotion: 'happy'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['cosyvoice3-generated', 'operation=duplex', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-cosyvoice3', estimatedDurationMs: 90000 }
}

export const ttsCosyvoice3InvalidEmotion: TestDefinition = {
  testId: 'tts-cosyvoice3-invalid-emotion',
  params: {
    text: 'This request must fail validation.',
    emotion: 'furious',
    stream: false
  },
  expectation: {
    validation: 'throws-error',
    errorContains: 'emotion'
  },
  metadata: { category: 'tts', dependency: 'none', estimatedDurationMs: 1000 }
}

// Audio8 takes no per-request conditioning fields, so its coverage exercises
// each operation shape with the load-time greedy/maxFrames/seed settings.
export const ttsAudio8Default: TestDefinition = {
  testId: 'tts-audio8-default',
  params: {
    text: 'Hello from Audio8.',
    stream: false
  },
  expectation: {
    validation: 'contains-all',
    contains: ['audio8-generated', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-audio8', estimatedDurationMs: 60000 }
}

export const ttsAudio8Streaming: TestDefinition = {
  testId: 'tts-audio8-streaming',
  params: {
    text: 'Audio8 can generate streaming speech.',
    operation: 'stream'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['audio8-generated', 'operation=stream', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-audio8', estimatedDurationMs: 90000 }
}

export const ttsAudio8SentenceStreaming: TestDefinition = {
  testId: 'tts-audio8-sentence-streaming',
  params: {
    text: 'This is the first sentence. This is the second sentence.',
    operation: 'sentence-stream'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['audio8-generated', 'operation=sentence-stream', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-audio8', estimatedDurationMs: 120000 }
}

export const ttsAudio8DuplexStreaming: TestDefinition = {
  testId: 'tts-audio8-duplex-streaming',
  params: {
    text: 'Audio8 also supports duplex text streaming.',
    operation: 'duplex'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['audio8-generated', 'operation=duplex', 'samples']
  },
  metadata: { category: 'tts', dependency: 'tts-audio8', estimatedDurationMs: 90000 }
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
  ttsSupertonicEnhanced,
  ttsParlerEmotionConditioning,
  ttsParlerDefaultDescription,
  ttsParlerStreaming,
  ttsParlerSentenceStreaming,
  ttsParlerDuplexStreaming,
  ttsParlerIndicMultilingual,
  ttsParlerInvalidEmotion,
  ttsCosyvoice3EmotionConditioning,
  ttsCosyvoice3Default,
  ttsCosyvoice3Streaming,
  ttsCosyvoice3NativeStreaming,
  ttsCosyvoice3SentenceStreaming,
  ttsCosyvoice3DuplexStreaming,
  ttsCosyvoice3InvalidEmotion,
  ttsAudio8Default,
  ttsAudio8Streaming,
  ttsAudio8SentenceStreaming,
  ttsAudio8DuplexStreaming
]

/**
 * Attach the declarative body to every definition that is one call.
 *
 * Done as a pass over the list rather than by editing thirty literals, on the
 * same conditions the executor branched on: which model the test names, and
 * whether its text is empty. Keeping the conditions in one place is what makes
 * it checkable that the migration did not quietly change any of them.
 */
for (const test of ttsTests) {
  if (TTS_COMPARISONS.has(test.testId)) continue
  const dependency = test.metadata?.dependency ?? 'tts-chatterbox'
  if (test.expectation.validation === 'throws-error') {
    test.steps = ttsRejectsRequest()
    continue
  }
  const { text } = test.params as { text?: string }
  test.steps = !text || text.trim().length === 0 ? ttsRefusesEmptyText(dependency) : ttsSteps(dependency)
}
