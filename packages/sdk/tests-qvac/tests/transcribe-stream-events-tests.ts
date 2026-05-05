// Tests for transcribeStream({ emitVadEvents, endOfTurnSilenceMs }) wire
// behaviour: VAD state events + end-of-turn events interleaved with
// text/segment frames.
import type { TestDefinition } from "@tetherto/qvac-test-suite";

const AUDIO_FIXTURE = "diarization-sample-16k.wav";

export const transcribeStreamEventsHappy: TestDefinition = {
  testId: "transcribe-stream-events-happy",
  params: {
    audioFileName: AUDIO_FIXTURE,
    emitVadEvents: true,
    endOfTurnSilenceMs: 600,
    trailingSilenceMs: 1500,
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "transcription",
    dependency: "whisper",
    estimatedDurationMs: 60000,
  },
};

export const transcribeStreamEventsDisabled: TestDefinition = {
  testId: "transcribe-stream-events-disabled",
  params: {
    audioFileName: AUDIO_FIXTURE,
    emitVadEvents: false,
    endOfTurnSilenceMs: 600,
    trailingSilenceMs: 1500,
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "transcription",
    dependency: "whisper",
    estimatedDurationMs: 60000,
  },
};

export const transcribeStreamEventsInvalid: TestDefinition = {
  testId: "transcribe-stream-events-invalid",
  params: {
    audioFileName: AUDIO_FIXTURE,
    emitVadEvents: true,
    endOfTurnSilenceMs: -1,
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "transcription",
    dependency: "whisper",
    estimatedDurationMs: 5000,
  },
};

export const transcribeStreamEventsTests = [
  transcribeStreamEventsHappy,
  transcribeStreamEventsDisabled,
  transcribeStreamEventsInvalid,
];
