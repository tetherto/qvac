import type { TestDefinition } from "@tetherto/qvac-test-suite";

type ParakeetDependency = "parakeet-tdt" | "parakeet-ctc" | "parakeet-sortformer";

const createParakeetTest = (
  testId: string,
  dependency: ParakeetDependency,
  audioFileName: string,
  expectation:
    | { validation: "contains-all" | "contains-any"; contains: string[] }
    | { validation: "type"; expectedType: "string" | "number" | "array" }
    | { validation: "throws-error"; errorContains: string },
  estimatedDurationMs: number = 60000,
): TestDefinition => ({
  testId,
  params: { audioFileName },
  expectation,
  metadata: {
    category: "parakeet",
    dependency,
    estimatedDurationMs,
  },
});

// ── TDT INT8 tests ────────────────────────────────────────────────────────────
// Parakeet TDT 0.6B INT8 — multilingual speech-to-text

export const parakeetTdtWav = createParakeetTest(
  "parakeet-tdt-wav",
  "parakeet-tdt",
  "transcription-short-wav.wav",
  { validation: "contains-all", contains: ["test", "automation"] },
  300000, // download ~700 MB
);

export const parakeetTdtMp3 = createParakeetTest(
  "parakeet-tdt-mp3",
  "parakeet-tdt",
  "transcription-short-mp3.mp3",
  { validation: "contains-all", contains: ["test", "automation"] },
  120000,
);

export const parakeetTdtM4a = createParakeetTest(
  "parakeet-tdt-m4a",
  "parakeet-tdt",
  "transcription-short-m4a.m4a",
  { validation: "contains-all", contains: ["test"] },
  120000,
);

export const parakeetTdtSilence = createParakeetTest(
  "parakeet-tdt-silence",
  "parakeet-tdt",
  "silence.m4a",
  { validation: "type", expectedType: "string" },
  120000,
);

// Multi-segment: audio longer than a single processing chunk
export const parakeetTdtMultiSegment = createParakeetTest(
  "parakeet-tdt-multi-segment",
  "parakeet-tdt",
  "diarization-sample-16k.wav",
  { validation: "type", expectedType: "string" },
  180000,
);

// Invalid MP3 — FFmpeg fails to decode it
export const parakeetTdtMusic = createParakeetTest(
  "parakeet-tdt-music",
  "parakeet-tdt",
  "only-music.mp3",
  { validation: "throws-error", errorContains: "Invalid data" },
  60000,
);

// Corrupted WAV — decoder throws a codec-level error
export const parakeetTdtCorruptedWav = createParakeetTest(
  "parakeet-tdt-corrupted-wav",
  "parakeet-tdt",
  "corrupted-wav.wav",
  { validation: "throws-error", errorContains: "" },
  60000,
);

// ── CTC tests ─────────────────────────────────────────────────────────────────
// Parakeet CTC FP32 — faster inference, no punctuation/capitalisation

export const parakeetCtcWav = createParakeetTest(
  "parakeet-ctc-wav",
  "parakeet-ctc",
  "transcription-short-wav.wav",
  { validation: "type", expectedType: "string" },
  600000, // CTC model download
);

export const parakeetCtcMp3 = createParakeetTest(
  "parakeet-ctc-mp3",
  "parakeet-ctc",
  "transcription-short-mp3.mp3",
  { validation: "contains-all", contains: ["test", "automation"] },
  120000,
);

export const parakeetCtcSilence = createParakeetTest(
  "parakeet-ctc-silence",
  "parakeet-ctc",
  "silence.m4a",
  { validation: "type", expectedType: "string" },
  120000,
);

// Corrupted WAV on CTC path
export const parakeetCtcCorruptedWav = createParakeetTest(
  "parakeet-ctc-corrupted-wav",
  "parakeet-ctc",
  "corrupted-wav.wav",
  { validation: "throws-error", errorContains: "" },
  60000,
);

// ── Sortformer (diarization) tests ────────────────────────────────────────────
// Parakeet Sortformer — speaker diarization, output: "Speaker N: Xs - Ys"

export const parakeetSortformerSingle = createParakeetTest(
  "parakeet-sortformer-single",
  "parakeet-sortformer",
  "diarization-sample-16k.wav",
  { validation: "contains-any", contains: ["Speaker"] },
  600000, // Sortformer model download
);

export const parakeetSortformerTwoSpeakers = createParakeetTest(
  "parakeet-sortformer-two-speakers",
  "parakeet-sortformer",
  "two-speakers-16k.wav",
  { validation: "contains-any", contains: ["Speaker"] },
  180000,
);

export const parakeetTdtTests = [
  parakeetTdtWav,
  parakeetTdtMp3,
  parakeetTdtM4a,
  parakeetTdtSilence,
  parakeetTdtMultiSegment,
  parakeetTdtMusic,
  parakeetTdtCorruptedWav,
];

export const parakeetCtcTests = [
  parakeetCtcWav,
  parakeetCtcMp3,
  parakeetCtcSilence,
  parakeetCtcCorruptedWav,
];

export const parakeetSortformerTests = [
  parakeetSortformerSingle,
  parakeetSortformerTwoSpeakers,
];

export const parakeetTests = [
  ...parakeetTdtTests,
  ...parakeetCtcTests,
  ...parakeetSortformerTests,
];
