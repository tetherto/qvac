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
    estimatedDurationMs: 360000
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
    estimatedDurationMs: 360000
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
    estimatedDurationMs: 360000
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

/**
 * ACE-Step caption augmentation: the BPM / key / time-signature hints are
 * reinforced in the engine's conditioning caption (`augmentCaptionWithMetadata`).
 */
export const audioGenAugmentedCaption: TestDefinition = {
  testId: 'audio-gen-augmented-caption',
  params: {
    caption: 'energetic cumbia with brass stabs and live percussion',
    lyrics: '[Instrumental]',
    seed: 98,
    duration: 2,
    bpm: 98,
    keyscale: 'A minor',
    timesignature: '4/4',
    augmentCaptionWithMetadata: true
  },
  expectation: {
    validation: 'contains-all',
    contains: ['generated', 'samples', 'progress', 'stats']
  },
  metadata: {
    category: 'audiogen',
    dependency: 'audiogen-turbo',
    estimatedDurationMs: 360000
  }
}

/**
 * Frozen semantic codes: the LM stage is skipped and the DiT synthesizes the
 * 38 five-hertz codes the addon's own integration suite renders, so the
 * output length is fixed by the codes rather than by `duration`.
 */
export const audioGenFrozenCodes: TestDefinition = {
  testId: 'audio-gen-frozen-codes',
  params: {
    caption: 'a short piano note',
    lyrics: '[Instrumental]',
    seed: 19,
    audioCodes: [
      12095, 63487, 12741, 54319, 52716, 20464, 2469, 515, 22717, 2326, 62840, 61416, 18896, 55746,
      54256, 12095, 63935, 12741, 54319, 52716, 20464, 2469, 515, 22718, 2455, 10103, 12567, 27863,
      30367, 30367, 30367, 30367, 30367, 30367, 30367, 30367, 30367, 15206
    ]
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
 * Ordered edit pipeline over in-memory source PCM (a short synthesized stereo
 * tone): a Flow-Edit followed by a Repaint of the middle second. Covers the
 * `audioEdit()` path end to end, including the turbo-only Flow-Edit branch.
 */
export const audioEditPipeline: TestDefinition = {
  testId: 'audio-edit-pipeline',
  params: {
    seed: 22883,
    sourceTone: { seconds: 2, frequency: 220 },
    operations: [
      {
        type: 'flow-edit',
        from: { caption: 'sustained sine tone' },
        to: { caption: 'warm analog synth pad' }
      },
      {
        type: 'repaint',
        caption: 'analog synth solo',
        lyrics: '[Instrumental]',
        start: 0.5,
        end: 1.5,
        mode: 'balanced',
        strength: 0.5
      }
    ]
  },
  expectation: {
    validation: 'contains-all',
    contains: ['edited', 'samples', 'progress', 'stats']
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

/** Client-side validation: an empty edit pipeline never reaches RPC. */
export const audioEditEmptyPipelineError: TestDefinition = {
  testId: 'audio-edit-empty-pipeline-error',
  params: {
    sourceTone: { seconds: 1, frequency: 220 },
    operations: []
  },
  expectation: {
    validation: 'throws-error',
    errorContains: 'operations'
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
  audioGenAugmentedCaption,
  audioGenFrozenCodes,
  audioEditPipeline,
  audioGenEmptyCaptionError,
  audioGenCoverMissingSourceError,
  audioEditEmptyPipelineError
] as const
