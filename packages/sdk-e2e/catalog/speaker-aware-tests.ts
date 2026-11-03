import type { TestDefinition } from '@qvac/test-suite'

export const speakerAwareTests: TestDefinition[] = [
  {
    testId: 'speaker-aware-moss-metadata',
    params: { mode: 'metadata' },
    expectation: {
      validation: 'contains-all',
      contains: ['Erin', 'exam', 'speaker:0', 'speaker:1']
    },
    metadata: {
      category: 'speaker-aware',
      dependency: 'moss-transcribe',
      estimatedDurationMs: 180000
    }
  },
  {
    testId: 'speaker-aware-moss-empty-hotwords',
    params: { mode: 'empty-hotwords' },
    expectation: { validation: 'contains-all', contains: ['exam', 'readings'] },
    metadata: {
      category: 'speaker-aware',
      dependency: 'moss-transcribe',
      estimatedDurationMs: 180000
    }
  },
  {
    testId: 'speaker-aware-moss-conflicting-prompt',
    params: { mode: 'conflicting-prompt' },
    expectation: { validation: 'throws-error', errorContains: 'hotwords' },
    metadata: {
      category: 'speaker-aware',
      dependency: 'moss-transcribe',
      estimatedDurationMs: 10000
    }
  },
  {
    testId: 'speaker-aware-nemotron-metadata',
    params: { mode: 'metadata' },
    expectation: { validation: 'contains-all', contains: ['speaker:0', 'speaker:1'] },
    metadata: {
      category: 'speaker-aware',
      dependency: 'nemotron-diarization',
      estimatedDurationMs: 60000
    }
  },
  {
    testId: 'speaker-aware-nemotron-text',
    params: { mode: 'text' },
    expectation: { validation: 'contains-all', contains: ['Speaker 0:', 'Speaker 1:', '00:00:'] },
    metadata: {
      category: 'speaker-aware',
      dependency: 'nemotron-diarization',
      estimatedDurationMs: 60000
    }
  },
  {
    testId: 'speaker-aware-nemotron-rejects-hotwords',
    params: { mode: 'hotwords' },
    expectation: { validation: 'throws-error', errorContains: 'MOSS' },
    metadata: {
      category: 'speaker-aware',
      dependency: 'nemotron-diarization',
      estimatedDurationMs: 10000
    }
  }
]
