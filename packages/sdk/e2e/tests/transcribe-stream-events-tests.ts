// Tests for transcribeStream({ emitVadEvents, endOfTurnSilenceMs }) wire
// behaviour: VAD state events + end-of-turn events interleaved with
// text/segment frames.
import type { Step, TestDefinition } from '@qvac/test-suite'

const AUDIO_FIXTURE = 'diarization-sample-16k.wav'

/**
 * Whisper's duplex session, driven the way the runner drove it: open, feed the
 * fixture in paced f32le chunks with a silence pad so end-of-turn detection
 * can fire, end the input, read the events out.
 */
const whisperStreamSteps = (emitVadEvents: boolean, checks: Step[]): Step[] => [
  { useModel: { deps: ['whisper'], as: 'model' } },
  { asset: { kind: 'audio', file: '$params.audioFileName', as: 'audio' } },
  {
    call: {
      method: 'transcribeStreamOpen',
      params: {
        modelId: '$model',
        ...(emitVadEvents ? { emitVadEvents: true } : {}),
        endOfTurnSilenceMs: '$params.endOfTurnSilenceMs?'
      },
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
        // Whisper takes the whole clip at once; only parakeet needs the feed
        // wall-clock paced, and pacing here would add a minute per test for
        // nothing.
        pace: false,
        chunkMs: 100,
        trailingSilenceMs: '$params.trailingSilenceMs?'
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
  { project: { from: '$drained', path: 'events', as: 'events' } },
  ...checks
]

/** Closes whatever session the body opened, on both paths. */
const destroySession: Step[] = [
  { call: { method: 'transcribeStreamDestroy', params: { sessionId: '$sessionId?' } } }
]

export const transcribeStreamEventsHappy: TestDefinition = {
  testId: 'transcribe-stream-events-happy',
  steps: whisperStreamSteps(true, [
    {
      assert: {
        on: '$events',
        named: 'eventTypeCounts',
        with: { atLeast: { vad: 1, endOfTurn: 1, text: 1 } }
      }
    }
  ]),
  finally: destroySession,
  params: {
    audioFileName: AUDIO_FIXTURE,
    emitVadEvents: true,
    endOfTurnSilenceMs: 600,
    trailingSilenceMs: 1500
  },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'transcription',
    dependency: 'whisper',
    estimatedDurationMs: 60000
  }
}

export const transcribeStreamEventsDisabled: TestDefinition = {
  testId: 'transcribe-stream-events-disabled',
  // The absent half is the test: with `emitVadEvents` off the transcript must
  // still arrive and the events must not.
  steps: whisperStreamSteps(false, [
    {
      assert: {
        on: '$events',
        named: 'eventTypeCounts',
        with: { atLeast: { text: 1 }, absent: ['vad', 'endOfTurn'] }
      }
    }
  ]),
  finally: destroySession,
  params: {
    audioFileName: AUDIO_FIXTURE,
    emitVadEvents: false,
    endOfTurnSilenceMs: 600,
    trailingSilenceMs: 1500
  },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'transcription',
    dependency: 'whisper',
    estimatedDurationMs: 60000
  }
}

export const transcribeStreamEventsInvalid: TestDefinition = {
  testId: 'transcribe-stream-events-invalid',
  // A negative silence window is refused when the session is opened, before
  // any audio is written.
  steps: [
    { useModel: { deps: ['whisper'], as: 'model' } },
    {
      callError: {
        method: 'transcribeStreamOpen',
        params: {
          modelId: '$model',
          emitVadEvents: true,
          endOfTurnSilenceMs: '$params.endOfTurnSilenceMs'
        },
        as: 'err'
      }
    },
    { project: { from: '$err', path: 'message', as: 'message' } },
    {
      assert: {
        on: '$message',
        named: 'containsAny',
        with: { terms: ['endOfTurnSilenceMs', 'nonnegative', 'invalid'] }
      }
    }
  ],
  params: {
    audioFileName: AUDIO_FIXTURE,
    emitVadEvents: true,
    endOfTurnSilenceMs: -1
  },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'transcription',
    dependency: 'whisper',
    estimatedDurationMs: 5000
  }
}

export const transcribeStreamEventsTests = [
  transcribeStreamEventsHappy,
  transcribeStreamEventsDisabled,
  transcribeStreamEventsInvalid
]
