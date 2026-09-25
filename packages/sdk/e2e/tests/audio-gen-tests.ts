import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * What a finished AudioGen run has to show for itself: audio with a described
 * format, progress that actually ticked, and stats.
 *
 * One `collect: 'pcm'` fold answers all three, because a second fold would be
 * a second generation -- minutes of work to ask a question about the first.
 */
const checkProducedAudio: Step[] = [
  { project: { from: '$run', path: 'audio', as: 'audio' } },
  { project: { from: '$audio', path: 'pcm', as: 'pcm' } },
  { assert: { on: '$pcm', named: 'producedAudio', with: { minSamples: 1 } } },
  {
    assert: {
      on: '$audio',
      named: 'positiveIntegers',
      with: { fields: ['sampleRate', 'channels', 'bitsPerSample'] }
    }
  },
  { project: { from: '$run', path: 'events', as: 'progress' } },
  { assert: { on: '$progress', named: 'lengthAtLeast', with: { length: 1 } } },
  { project: { from: '$run', path: 'stats', as: 'stats' } },
  { assert: { on: '$stats', named: 'fieldsPresent', with: { fields: ['backendId'] } } }
]

/**
 * A generation, with only the parameters the test actually sets.
 *
 * The optional `?` references leave an argument out rather than passing it as
 * null: an SDK that tells "absent" from "explicitly nothing" would otherwise
 * see a different call than the test meant to make.
 */
const generationSteps = (extra: Record<string, unknown> = {}): Step[] => [
  { useModel: { deps: ['audiogen-turbo'], as: 'model' } },
  {
    call: {
      method: 'audioGen',
      collect: 'pcm',
      params: {
        modelId: '$model',
        caption: '$params.caption',
        lyrics: '$params.lyrics?',
        seed: '$params.seed?',
        duration: '$params.duration?',
        bpm: '$params.bpm?',
        keyscale: '$params.keyscale?',
        timesignature: '$params.timesignature?',
        augmentCaptionWithMetadata: '$params.augmentCaptionWithMetadata?',
        audioCodes: '$params.audioCodes?',
        taskType: '$params.taskType?',
        audioCoverStrength: '$params.audioCoverStrength?',
        coverNoiseStrength: '$params.coverNoiseStrength?',
        ...extra
      },
      as: 'run'
    }
  },
  ...checkProducedAudio
]

/**
 * Client-side validation: the call must be refused before it reaches RPC.
 *
 * The model id is deliberately one no registry holds -- if the check were to
 * move behind the wire, the test would fail on the lookup rather than quietly
 * passing for the wrong reason.
 */
const VALIDATION_MUST_PRECEDE_RPC_MODEL_ID = 'must-not-reach-audiogen-model-lookup'

const validationErrorSteps = (
  method: 'audioGen' | 'audioEdit',
  params: Record<string, unknown>
): Step[] => [
  {
    callError: {
      method,
      collect: 'pcm',
      params: { modelId: VALIDATION_MUST_PRECEDE_RPC_MODEL_ID, ...params },
      as: 'error'
    }
  },
  { project: { from: '$error', path: 'message', as: 'message' } },
  { assert: { on: '$message', use: 'expectation' } }
]

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
  steps: generationSteps(),
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
  steps: generationSteps(),
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
  steps: [
    { asset: { kind: 'audio', file: '$params.referenceAudioFileName', form: 'path', as: 'ref' } },
    ...generationSteps({ referenceAudio: '$ref' })
  ],
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
    sourceTone: '1s-220hz'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['generated', 'samples', 'progress', 'stats']
  },
  steps: [
    { asset: { kind: 'tone', file: '$params.sourceTone', as: 'source' } },
    ...generationSteps({ sourceAudio: '$source' })
  ],
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
  steps: generationSteps(),
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
  steps: generationSteps(),
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
    sourceTone: '2s-220hz',
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
  steps: [
    { asset: { kind: 'tone', file: '$params.sourceTone', as: 'source' } },
    { useModel: { deps: ['audiogen-turbo'], as: 'model' } },
    {
      call: {
        method: 'audioEdit',
        collect: 'pcm',
        params: {
          modelId: '$model',
          sourceAudio: '$source',
          operations: '$params.operations',
          seed: '$params.seed?'
        },
        as: 'run'
      }
    },
    ...checkProducedAudio
  ],
  metadata: {
    category: 'audiogen',
    dependency: 'audiogen-turbo',
    estimatedDurationMs: 300000
  }
}

/**
 * The reverse pipeline over in-memory source PCM (a short synthesized stereo
 * tone): encode, recover the FSQ codes, and have the LM describe the clip.
 * Covers `audioUnderstand()` end to end, including the description promise.
 */
export const audioUnderstandClip: TestDefinition = {
  testId: 'audio-understand-clip',
  params: {
    seed: 11,
    sourceTone: '2s-220hz'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['described', 'codes', 'progress', 'stats']
  },
  steps: [
    { asset: { kind: 'tone', file: '$params.sourceTone', as: 'source' } },
    { useModel: { deps: ['audiogen-turbo'], as: 'model' } },
    {
      call: {
        method: 'audioUnderstand',
        collect: 'text',
        params: { modelId: '$model', sourceAudio: '$source', seed: '$params.seed?' },
        as: 'run'
      }
    },
    { project: { from: '$run', path: 'text.caption', as: 'caption' } },
    { assert: { on: '$caption', named: 'nonEmptyText' } },
    { project: { from: '$run', path: 'text.audioCodes', as: 'codes' } },
    { assert: { on: '$codes', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  metadata: {
    category: 'audiogen',
    dependency: 'audiogen-turbo',
    estimatedDurationMs: 300000
  }
}

/** Client-side validation: a lego task without a track never reaches RPC. */
export const audioGenLegoMissingTrackError: TestDefinition = {
  testId: 'audio-gen-lego-missing-track-error',
  params: {
    caption: 'the same song with a busier kit',
    taskType: 'lego'
  },
  expectation: {
    validation: 'throws-error',
    errorContains: 'track'
  },
  steps: validationErrorSteps('audioGen', {
    caption: '$params.caption',
    taskType: '$params.taskType'
  }),
  metadata: {
    category: 'audiogen',
    dependency: 'none',
    estimatedDurationMs: 1000
  }
}

/** Client-side validation: Simple Mode and Query Rewriting are exclusive. */
export const audioGenSimpleModeConflictError: TestDefinition = {
  testId: 'audio-gen-simple-mode-conflict-error',
  params: {
    caption: 'a hopeful indie track',
    simpleMode: true,
    rewriteQuery: true
  },
  expectation: {
    validation: 'throws-error',
    errorContains: 'rewriteQuery'
  },
  steps: validationErrorSteps('audioGen', {
    caption: '$params.caption',
    simpleMode: '$params.simpleMode',
    rewriteQuery: '$params.rewriteQuery'
  }),
  metadata: {
    category: 'audiogen',
    dependency: 'none',
    estimatedDurationMs: 1000
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
  steps: validationErrorSteps('audioGen', { caption: '$params.caption' }),
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
  steps: validationErrorSteps('audioGen', {
    caption: '$params.caption',
    taskType: '$params.taskType'
  }),
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
    sourceTone: '1s-220hz',
    operations: []
  },
  expectation: {
    validation: 'throws-error',
    errorContains: 'operations'
  },
  steps: [
    { asset: { kind: 'tone', file: '$params.sourceTone', as: 'source' } },
    ...validationErrorSteps('audioEdit', {
      sourceAudio: '$source',
      operations: '$params.operations'
    })
  ],
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
  audioUnderstandClip,
  audioGenEmptyCaptionError,
  audioGenCoverMissingSourceError,
  audioGenLegoMissingTrackError,
  audioGenSimpleModeConflictError,
  audioEditEmptyPipelineError
] as const
