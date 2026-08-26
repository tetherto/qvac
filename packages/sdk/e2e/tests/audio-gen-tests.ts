import type { TestDefinition } from '@qvac/test-suite'

export const audioGenHappy: TestDefinition = {
  testId: 'audio-gen-happy',
  params: {
    caption: 'warm ambient electronic music with a gentle piano melody',
    lyrics: '[Instrumental]',
    seed: 42,
    duration: 5
  },
  expectation: {
    validation: 'contains-all',
    contains: ['generated', 'samples', 'progress', 'stats']
  },
  metadata: {
    category: 'audiogen',
    dependency: 'audiogen-turbo',
    estimatedDurationMs: 300000
  }
}

export const audioGenShortDuration: TestDefinition = {
  testId: 'audio-gen-short-duration',
  params: {
    caption: 'one sustained piano note',
    lyrics: '[Instrumental]',
    seed: 7,
    duration: 1
  },
  expectation: {
    validation: 'contains-all',
    contains: ['generated', 'samples', 'progress', 'stats']
  },
  metadata: {
    category: 'audiogen',
    dependency: 'audiogen-turbo',
    estimatedDurationMs: 300000
  }
}

/**
 * Timbre conditioning from a bundled audio asset: the file path travels over
 * RPC and is decoded server-side (FFmpeg → 48 kHz stereo float) before the
 * ACE-Step run, so this covers the whole `referenceAudio` file path.
 */
export const audioGenReferenceAudio: TestDefinition = {
  testId: 'audio-gen-reference-audio',
  params: {
    caption: 'slow blues with warm electric guitar',
    lyrics: '[Instrumental]',
    seed: 11,
    duration: 3,
    referenceAudioFileName: 'sample-hi.wav'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['generated', 'samples', 'progress', 'stats']
  },
  metadata: {
    category: 'audiogen',
    dependency: 'audiogen-turbo',
    estimatedDurationMs: 300000
  }
}

/**
 * ACE-Step `cover-nofsq`: re-render in-memory source PCM (a short synthesized
 * stereo tone handed over as a raw Float32 buffer) with a new caption. Covers
 * the `sourceAudio` buffer path, `taskType`, and the cover strength controls.
 */
export const audioGenCoverNofsq: TestDefinition = {
  testId: 'audio-gen-cover-nofsq',
  params: {
    caption: 'orchestral arrangement with dramatic strings',
    lyrics: '[Instrumental]',
    seed: 22886,
    taskType: 'cover-nofsq',
    audioCoverStrength: 1,
    coverNoiseStrength: 0.75,
    sourceTone: { seconds: 1, frequency: 220 }
  },
  expectation: {
    validation: 'contains-all',
    contains: ['generated', 'samples', 'progress', 'stats']
  },
  metadata: {
    category: 'audiogen',
    dependency: 'audiogen-turbo',
    estimatedDurationMs: 300000
  }
}

export const audioGenEmptyCaptionError: TestDefinition = {
  testId: 'audio-gen-empty-caption-error',
  params: {
    caption: ' '
  },
  expectation: {
    validation: 'throws-error',
    errorContains: 'caption'
  },
  metadata: {
    category: 'audiogen',
    dependency: 'none',
    estimatedDurationMs: 1000
  }
}

/** Client-side validation: a cover task without source audio never reaches RPC. */
export const audioGenCoverMissingSourceError: TestDefinition = {
  testId: 'audio-gen-cover-missing-source-error',
  params: {
    caption: 'orchestral arrangement with dramatic strings',
    taskType: 'cover-nofsq'
  },
  expectation: {
    validation: 'throws-error',
    errorContains: 'sourceAudio'
  },
  metadata: {
    category: 'audiogen',
    dependency: 'none',
    estimatedDurationMs: 1000
  }
}

export const audioGenTests = [
  audioGenHappy,
  audioGenShortDuration,
  audioGenReferenceAudio,
  audioGenCoverNofsq,
  audioGenEmptyCaptionError,
  audioGenCoverMissingSourceError
] as const
