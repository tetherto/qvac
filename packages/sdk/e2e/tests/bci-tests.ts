// BCI (brain-computer interface) transcription test definitions.
//
// Drives the BCI whisper.cpp addon through the public SDK surface:
// `bciTranscribe` (batch) and `bciTranscribeStream` (duplex). The neural
// input is a committed fixture (`assets/neural/neural-not-too-controversial.bin`,
// sample 2 from the addon's test set) recorded on session day_idx 1. The
// addon decodes it deterministically (temperature 0, WER 0.0) to
// "not too controversial", so "controversial" is a stable assertable token.
import type { TestDefinition } from "@tetherto/qvac-test-suite";

const NEURAL_FILE = "neural-not-too-controversial.bin";

// Happy path: batch transcription of a known neural buffer.
export const bciTranscribeBatch: TestDefinition = {
  testId: "bci-transcribe-batch",
  params: { neuralFileName: NEURAL_FILE },
  expectation: { validation: "contains-any", contains: ["controversial"] },
  suites: ["smoke"],
  metadata: {
    category: "bci",
    dependency: "bci",
    estimatedDurationMs: 60000,
  },
};

// Sad path: same input through the streaming duplex surface (must still
// succeed). `emit: "full"` yields the running transcript each window.
export const bciTranscribeStream: TestDefinition = {
  testId: "bci-transcribe-stream",
  params: { neuralFileName: NEURAL_FILE },
  expectation: { validation: "contains-any", contains: ["controversial"] },
  metadata: {
    category: "bci",
    dependency: "bci",
    estimatedDurationMs: 120000,
  },
};

// Error path: a non-existent neural file must surface as a thrown error.
export const bciTranscribeMissingFile: TestDefinition = {
  testId: "bci-transcribe-error-missing-file",
  params: { neuralFileName: "does-not-exist.bin" },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: {
    category: "bci",
    dependency: "bci",
    estimatedDurationMs: 10000,
  },
};

export const bciTests = [
  bciTranscribeBatch,
  bciTranscribeStream,
  bciTranscribeMissingFile,
];
