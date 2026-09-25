// Transcription test definitions
import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * One transcription of one audio fixture.
 *
 * `asset` with `form: 'path'` is what lets this run on desktop and on mobile
 * from one body: the two executors differed in nothing but how an audio file
 * name became something the SDK could open.
 */
const transcriptionSteps = (dependency = 'whisper'): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  { asset: { kind: 'audio', file: '$params.audioFileName', form: 'path', as: 'audio' } },
  {
    call: {
      method: 'transcribe',
      params: { modelId: '$model', audioChunk: '$audio', prompt: '$params.prompt?' },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'text', as: 'text' } },
  { assert: { on: '$text', use: 'expectation' } }
]

/** A transcription that must be rejected, e.g. a corrupted file. */
const transcriptionRejects = (dependency = 'whisper'): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  { asset: { kind: 'audio', file: '$params.audioFileName', form: 'path', as: 'audio' } },
  {
    callError: {
      method: 'transcribe',
      params: { modelId: '$model', audioChunk: '$audio' },
      as: 'err'
    }
  },
  { project: { from: '$err', path: 'message', as: 'message' } },
  { assert: { on: '$message', use: 'expectation' } }
]

/**
 * Bodies that are more than one call: a queue recovering from a malformed
 * chunk, and the two metadata tests that assert on segment structure rather
 * than on the transcript.
 */
const TRANSCRIPTION_MULTI_STEP = new Set([
  'transcription-f32le-queue-recovery',
  'transcription-metadata-batch',
  'transcription-metadata-streaming'
])

/** Closes whatever session the body opened, on both paths. */
const destroySession: Step[] = [
  { call: { method: 'transcribeStreamDestroy', params: { sessionId: '$sessionId?' } } }
]

const createTranscriptionTest = (
  testId: string,
  audioFileName: string,
  expectation:
    | { validation: 'contains-all' | 'contains-any'; contains: string[] }
    | {
        validation: 'type'
        expectedType: 'string' | 'number' | 'array'
      }
    | { validation: 'regex'; pattern: string },
  estimatedDurationMs: number = 30000,
  suites?: string[]
): TestDefinition => ({
  testId,
  params: { audioFileName, timeout: 300000 },
  expectation,
  ...(suites && { suites }),
  steps: TRANSCRIPTION_MULTI_STEP.has(testId) ? undefined : transcriptionSteps(),
  metadata: {
    category: 'transcription',
    dependency: 'whisper',
    estimatedDurationMs
  }
})

export const transcriptionShortWav = createTranscriptionTest(
  'transcription-short-wav',
  'transcription-short-wav.wav',
  {
    validation: 'contains-all',
    contains: ['test', 'automation']
  },
  30000,
  ['smoke']
)

export const transcriptionF32leQueueRecovery: TestDefinition = {
  testId: 'transcription-f32le-queue-recovery',
  params: {
    audioFileName: 'transcription-short-wav.wav'
  },
  expectation: { validation: 'contains-all', contains: ['test', 'automation'] },
  metadata: {
    category: 'transcription',
    dependency: 'whisper',
    estimatedDurationMs: 45000
  }
}

export const transcriptionShortMp3 = createTranscriptionTest(
  'transcription-short-mp3',
  'transcription-short-mp3.mp3',
  {
    validation: 'contains-all',
    contains: ['test', 'automation']
  },
  30000,
  ['smoke']
)

export const transcriptionShortAac = createTranscriptionTest(
  'transcription-short-aac',
  'transcription-short-aac.aac',
  {
    validation: 'contains-all',
    contains: ['test', 'automation']
  }
)

export const transcriptionShortM4a = createTranscriptionTest(
  'transcription-short-m4a',
  'transcription-short-m4a.m4a',
  {
    validation: 'contains-all',
    contains: ['test']
  }
)

export const transcriptionShortOgg = createTranscriptionTest(
  'transcription-short-ogg',
  'transcription-short-ogg.ogg',
  { validation: 'type', expectedType: 'string' } // Just verify it transcribes something
)

export const transcriptionSilence = createTranscriptionTest(
  'transcription-silence',
  'silence.m4a',
  {
    validation: 'type',
    expectedType: 'string'
  }
)

export const transcriptionStreaming = createTranscriptionTest(
  'transcription-streaming',
  'transcription-short-wav.wav',
  { validation: 'type', expectedType: 'string' },
  10000,
  ['smoke']
)

export const transcriptionVeryShort = createTranscriptionTest(
  'transcription-very-short',
  'transcription-short-m4a.m4a',
  { validation: 'contains-all', contains: ['test'] },
  5000
)

export const transcriptionCorruptedMp3: TestDefinition = {
  testId: 'transcription-corrupted-mp3',
  params: { audioFileName: 'corrupted-mp3.mp3' },
  expectation: { validation: 'throws-error', errorContains: '' },
  suites: ['smoke'],
  metadata: { category: 'transcription', dependency: 'whisper', estimatedDurationMs: 30000 }
}

export const transcriptionCorruptedWav: TestDefinition = {
  testId: 'transcription-corrupted-wav',
  params: { audioFileName: 'corrupted-wav.wav' },
  expectation: { validation: 'throws-error', errorContains: '' },
  metadata: { category: 'transcription', dependency: 'whisper', estimatedDurationMs: 30000 }
}

export const transcriptionWithPrompt: TestDefinition = {
  testId: 'transcription-with-prompt',
  params: {
    audioFileName: 'transcription-short-wav.wav',
    prompt: 'This is a test recording about QVAC SDK automation testing.'
  },
  expectation: { validation: 'contains-any', contains: ['test', 'QVAC'] },
  suites: ['smoke'],
  metadata: { category: 'transcription', dependency: 'whisper', estimatedDurationMs: 30000 }
}

export const transcriptionPromptTechnical: TestDefinition = {
  testId: 'transcription-prompt-technical',
  params: {
    audioFileName: 'transcription-short-wav.wav',
    prompt: 'Technical terms: SDK, API, TypeScript, JavaScript, QVAC, Whisper, transcription.'
  },
  expectation: { validation: 'contains-any', contains: ['test'] },
  metadata: { category: 'transcription', dependency: 'whisper', estimatedDurationMs: 30000 }
}

export const transcriptionPromptPunctuation: TestDefinition = {
  testId: 'transcription-prompt-punctuation',
  params: {
    audioFileName: 'transcription-short-wav.wav',
    prompt: 'Use proper punctuation. Include periods, commas, and question marks.'
  },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'transcription', dependency: 'whisper', estimatedDurationMs: 30000 }
}

export const transcriptionWithoutPrompt: TestDefinition = {
  testId: 'transcription-without-prompt',
  params: {
    audioFileName: 'transcription-short-wav.wav',
    prompt: null
  },
  expectation: { validation: 'contains-any', contains: ['test'] },
  metadata: { category: 'transcription', dependency: 'whisper', estimatedDurationMs: 30000 }
}

export const transcriptionPromptEmpty: TestDefinition = {
  testId: 'transcription-prompt-empty',
  params: {
    audioFileName: 'transcription-short-wav.wav',
    prompt: ''
  },
  expectation: { validation: 'contains-any', contains: ['test'] },
  metadata: { category: 'transcription', dependency: 'whisper', estimatedDurationMs: 30000 }
}

export const transcriptionMetadataBatch: TestDefinition = {
  testId: 'transcription-metadata-batch',
  params: { audioFileName: 'transcription-short-wav.wav', metadata: true },
  expectation: { validation: 'function', fn: () => true },
  steps: [
    { useModel: { deps: ['whisper'], as: 'model' } },
    { asset: { kind: 'audio', file: '$params.audioFileName', form: 'path', as: 'audio' } },
    {
      call: {
        method: 'transcribe',
        params: { modelId: '$model', audioChunk: '$audio', metadata: true },
        as: 'run'
      }
    },
    { project: { from: '$run', path: 'segments', as: 'segments' } },
    { assert: { on: '$segments', named: 'transcriptSegmentsShape' } }
  ],
  metadata: {
    category: 'transcription',
    dependency: 'whisper',
    estimatedDurationMs: 30000
  }
}

export const transcriptionMetadataStreaming: TestDefinition = {
  testId: 'transcription-metadata-streaming',
  params: {
    audioFileName: 'diarization-sample-16k.wav',
    trailingSilenceMs: 1500,
    chunkMs: 100
  },
  expectation: { validation: 'function', fn: () => true },
  // The same segment contract as the batch case, over a live session: a
  // streaming transcript that arrived out of audio-time order would reassemble
  // wrong without any one segment looking wrong.
  steps: [
    { useModel: { deps: ['whisper'], as: 'model' } },
    { asset: { kind: 'audio', file: '$params.audioFileName', as: 'audio' } },
    {
      call: {
        method: 'transcribeStreamOpen',
        params: { modelId: '$model', metadata: true },
        as: 'session'
      }
    },
    { project: { from: '$session', path: 'sessionId', as: 'sessionId' } },
    {
      call: {
        method: 'transcribeStreamWrite',
        params: {
          sessionId: '$sessionId',
          audio: '$audio',
          sampleFormat: 'f32le',
          pace: false,
          chunkMs: '$params.chunkMs',
          trailingSilenceMs: '$params.trailingSilenceMs'
        }
      }
    },
    { call: { method: 'transcribeStreamEnd', params: { sessionId: '$sessionId' } } },
    {
      call: {
        method: 'transcribeStreamDrain',
        collect: 'events',
        params: { sessionId: '$sessionId' },
        as: 'drained'
      }
    },
    { project: { from: '$drained', path: 'events', as: 'segments' } },
    { assert: { on: '$segments', named: 'transcriptSegmentsShape' } }
  ],
  finally: destroySession,
  metadata: {
    category: 'transcription',
    dependency: 'whisper',
    estimatedDurationMs: 60000
  }
}

export const transcriptionTests = [
  transcriptionShortWav,
  transcriptionF32leQueueRecovery,
  transcriptionShortMp3,
  transcriptionShortAac,
  transcriptionShortOgg,
  transcriptionSilence,
  transcriptionStreaming,
  transcriptionVeryShort,
  transcriptionShortM4a,
  transcriptionCorruptedMp3,
  transcriptionCorruptedWav,
  transcriptionWithPrompt,
  transcriptionPromptTechnical,
  transcriptionPromptPunctuation,
  transcriptionWithoutPrompt,
  transcriptionPromptEmpty,
  transcriptionMetadataBatch,
  transcriptionMetadataStreaming
]

/**
 * Attach a body to the definitions written as literals rather than through the
 * factory. Same three shapes the executor dispatched on: a rejection, a
 * prompted transcription, a plain one.
 */
for (const test of transcriptionTests) {
  if (test.steps || TRANSCRIPTION_MULTI_STEP.has(test.testId)) continue
  test.steps =
    test.expectation.validation === 'throws-error' ? transcriptionRejects() : transcriptionSteps()
}
