// BCI (brain-computer interface) transcription test definitions.
//
// Drives the BCI whisper.cpp addon through the public SDK surface:
// `bciTranscribe` (batch) and `bciTranscribeStream` (duplex). The neural
// input is a committed fixture (`assets/neural/neural-not-too-controversial.bin`,
// sample 2 from the addon's test set) recorded on session day_idx 1. The
// addon decodes it deterministically (temperature 0, WER 0.0) to
// "not too controversial", so "controversial" is a stable assertable token.
import type { Step, TestDefinition } from '@qvac/test-suite'

const NEURAL_FILE = 'neural-not-too-controversial.bin'

/**
 * How much of the fixture goes in at a time.
 *
 * The addon decodes over a sliding window, so the stream has to arrive in
 * pieces rather than all at once -- a single write would leave nothing for the
 * window to slide over.
 */
const STREAM_CHUNK_BYTES = 64 * 1024

/** Closes whatever session the body opened, on both paths. */
const destroySession: Step[] = [
  { call: { method: 'transcribeStreamDestroy', params: { sessionId: '$sessionId?' } } }
]

// Happy path: batch transcription of a known neural buffer.
export const bciTranscribeBatch: TestDefinition = {
  testId: 'bci-transcribe-batch',
  params: { neuralFileName: NEURAL_FILE },
  expectation: { validation: 'contains-any', contains: ['controversial'] },
  suites: ['smoke'],
  steps: [
    { useModel: { deps: ['bci'], as: 'model' } },
    { asset: { kind: 'neural', file: '$params.neuralFileName', form: 'path', as: 'neural' } },
    {
      call: {
        method: 'bciTranscribe',
        params: { modelId: '$model', neuralData: '$neural' },
        as: 'run'
      }
    },
    { project: { from: '$run', path: 'text', as: 'text' } },
    { assert: { on: '$text', use: 'expectation' } }
  ],
  metadata: {
    category: 'bci',
    dependency: 'bci',
    estimatedDurationMs: 60000
  }
}

// Sad path: same input through the streaming duplex surface (must still
// succeed). `emit: "full"` yields the running transcript each window.
export const bciTranscribeStream: TestDefinition = {
  testId: 'bci-transcribe-stream',
  params: { neuralFileName: NEURAL_FILE },
  expectation: { validation: 'contains-any', contains: ['controversial'] },
  // `emit: 'full'` yields the running transcript each window, so the drained
  // events join into the whole thing rather than into deltas.
  steps: [
    { useModel: { deps: ['bci'], as: 'model' } },
    { asset: { kind: 'neural', file: '$params.neuralFileName', as: 'neural' } },
    {
      call: {
        method: 'bciTranscribeStreamOpen',
        params: { modelId: '$model', emit: 'full' },
        as: 'session'
      }
    },
    { project: { from: '$session', path: 'sessionId', as: 'sessionId' } },
    {
      call: {
        method: 'transcribeStreamWriteBytes',
        params: {
          sessionId: '$sessionId',
          data: '$neural',
          chunkBytes: STREAM_CHUNK_BYTES
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
    { project: { from: '$drained', path: 'events[*].text', join: '', as: 'text' } },
    { assert: { on: '$text', use: 'expectation' } }
  ],
  finally: destroySession,
  metadata: {
    category: 'bci',
    dependency: 'bci',
    estimatedDurationMs: 120000
  }
}

// Error path: a non-existent neural file must surface as a thrown error.
export const bciTranscribeMissingFile: TestDefinition = {
  testId: 'bci-transcribe-error-missing-file',
  // A path rather than a fixture name: the file is not there, so resolving it
  // through `asset` would fail in the step instead of in the call, which is
  // the opposite of what this test is about. Relative to the consumer's
  // working directory, which is where the bci category runs.
  params: { neuralDataPath: 'assets/neural/does-not-exist.bin' },
  expectation: { validation: 'throws-error', errorContains: '' },
  steps: [
    { useModel: { deps: ['bci'], as: 'model' } },
    {
      callError: {
        method: 'bciTranscribe',
        params: { modelId: '$model', neuralData: '$params.neuralDataPath' },
        as: 'err'
      }
    },
    // The message, not the structure. This refusal is a bare ENOENT with
    // neither a code nor a cause -- worth fixing in the SDK, but asserting
    // structure here would fail the test for a gap the executor never claimed
    // to check: its expectation was `errorContains: ''`, which matches
    // anything at all.
    { project: { from: '$err', path: 'message', as: 'message' } },
    {
      assert: {
        on: '$message',
        named: 'containsAll',
        with: { terms: ['does-not-exist.bin'] }
      }
    }
  ],
  metadata: {
    category: 'bci',
    dependency: 'bci',
    estimatedDurationMs: 10000
  }
}

export const bciTests = [bciTranscribeBatch, bciTranscribeStream, bciTranscribeMissingFile]
