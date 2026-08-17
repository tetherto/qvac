import type { TestDefinition } from '@qvac/qvac-test-suite'

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

export const audioGenTests = [
  audioGenHappy,
  audioGenShortDuration,
  audioGenEmptyCaptionError
] as const
