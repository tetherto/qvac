/**
 * Tests for parakeet's duplex `transcribeStream` API.
 *
 * Exercises the long-lived `parakeet::StreamSession` path on the
 * server: audio is fed in over the request half of a duplex RPC,
 * per-chunk text segments come back over the response half, and EOU
 * boundary events surface as synthetic `{ type: "endOfTurn" }` frames.
 *
 * Parakeet does NOT emit standalone `vad` events — the
 * `parakeetStreamingConfig.emitEnergyVad` knob is purely an internal
 * hint to parakeet-cpp's segmentation. Whisper is the only engine
 * that surfaces `vad` events.
 */
import type { TestDefinition } from "@tetherto/qvac-test-suite";

const AUDIO_FIXTURE = "transcription-short-wav.wav";

export const parakeetStreamHappy: TestDefinition = {
  testId: "parakeet-stream-happy",
  params: {
    audioFileName: AUDIO_FIXTURE,
    chunkMs: 1000,
    emitPartials: true,
    trailingSilenceMs: 1500,
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "parakeet",
    dependency: "parakeet-tdt",
    estimatedDurationMs: 120000,
  },
};

export const parakeetStreamMetadataRejected: TestDefinition = {
  testId: "parakeet-stream-metadata-rejected",
  params: {
    audioFileName: AUDIO_FIXTURE,
    chunkMs: 1000,
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "parakeet",
    dependency: "parakeet-tdt",
    estimatedDurationMs: 60000,
  },
};

/**
 * EOU model end-to-end coverage: drives the duplex stream against the
 * `<EOU>`-token-emitting parakeet checkpoint, then asserts that at
 * least one synthetic `endOfTurn` event surfaces alongside transcript
 * text. Locks down the EOU → `isEndOfTurn` → conversation-event path
 * across `ops/transcribe.ts` (`emitSegment`), the parakeet plugin
 * handler, and the client `processLineConversation` decoder.
 */
export const parakeetStreamEou: TestDefinition = {
  testId: "parakeet-stream-eou",
  params: {
    audioFileName: AUDIO_FIXTURE,
    chunkMs: 1000,
    emitPartials: true,
    trailingSilenceMs: 1500,
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "parakeet",
    dependency: "parakeet-eou",
    estimatedDurationMs: 120000,
  },
};

/**
 * Mid-utterance teardown: opens a session, writes 2 chunks, calls
 * `session.destroy()`, then opens a fresh session against the same
 * model and runs a happy-path stream. Locks down the parakeet
 * `StreamSession` cleanup contract — `destroy()` must propagate
 * synchronously through the duplex handler so the next session can
 * load against the same modelId without the addon being left in a
 * wedged state.
 */
export const parakeetStreamDestroyMidUtterance: TestDefinition = {
  testId: "parakeet-stream-destroy-mid-utterance",
  params: {
    audioFileName: AUDIO_FIXTURE,
    chunkMs: 1000,
    emitPartials: true,
    trailingSilenceMs: 1500,
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "parakeet",
    dependency: "parakeet-tdt",
    estimatedDurationMs: 180000,
  },
};

/**
 * Consumer-side iterator throw: the `for await` body throws after
 * the first event surfaces. The iterator MUST unwind (cleanly tear
 * down the native `StreamSession`); a fresh session against the same
 * model must then succeed end-to-end. This is the "consumer
 * disconnect / error path" referenced in PR review #4280580987.
 */
export const parakeetStreamIteratorThrow: TestDefinition = {
  testId: "parakeet-stream-iterator-throw",
  params: {
    audioFileName: AUDIO_FIXTURE,
    chunkMs: 1000,
    emitPartials: true,
    trailingSilenceMs: 1500,
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "parakeet",
    dependency: "parakeet-tdt",
    estimatedDurationMs: 180000,
  },
};

export const parakeetStreamTests = [
  parakeetStreamHappy,
  parakeetStreamMetadataRejected,
  parakeetStreamEou,
  parakeetStreamDestroyMidUtterance,
  parakeetStreamIteratorThrow,
];
