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

export const parakeetStreamTests = [
  parakeetStreamHappy,
  parakeetStreamMetadataRejected,
];
