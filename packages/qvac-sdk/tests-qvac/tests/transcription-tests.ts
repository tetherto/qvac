// Transcription test definitions
import type { TestDefinition } from "@tetherto/qvac-test-suite";

const createTranscriptionTest = (
  testId: string,
  audioFileName: string,
  expectation:
    | { validation: "contains-all" | "contains-any"; contains: string[] }
    | {
        validation: "type";
        expectedType: "string" | "number" | "array" | "embedding";
      }
    | { validation: "regex"; pattern: string },
  estimatedDurationMs: number = 30000,
): TestDefinition => ({
  testId,
  params: { audioFileName, timeout: 300000 },
  expectation,
  metadata: {
    category: "transcription",
    dependency: "whisper",
    estimatedDurationMs,
  },
});

export const transcriptionShortWav = createTranscriptionTest(
  "transcription-short-wav",
  "transcription-short.wav",
  {
    validation: "contains-all",
    contains: ["test", "automation"],
  },
);

export const transcriptionShortMp3 = createTranscriptionTest(
  "transcription-short-mp3",
  "transcription-short.mp3",
  {
    validation: "contains-all",
    contains: ["test", "automation"],
  },
);

export const transcriptionAac = createTranscriptionTest(
  "transcription-aac",
  "transcription-short.aac",
  {
    validation: "contains-all",
    contains: ["test", "automation"],
  },
);

export const transcriptionM4a = createTranscriptionTest(
  "transcription-m4a",
  "transcription-short.m4a",
  {
    validation: "contains-all",
    contains: ["test"],
  },
);

export const transcriptionOgg = createTranscriptionTest(
  "transcription-ogg",
  "transcription-short.ogg",
  { validation: "type", expectedType: "string" }, // Just verify it transcribes something
);

export const transcriptionSilence = createTranscriptionTest(
  "transcription-silence",
  "silence.m4a",
  {
    validation: "type",
    expectedType: "string",
  },
);

export const transcriptionOnlyMusic = createTranscriptionTest(
  "transcription-only-music",
  "only-music.mp3",
  { validation: "type", expectedType: "string" }, // May hallucinate, just verify no crash
);

export const transcriptionLongAudio = createTranscriptionTest(
  "transcription-long-audio",
  "10min-mp3-320kbps.mp3",
  { validation: "type", expectedType: "string" },
  600000, // 10 minutes
);

export const transcriptionStreaming = createTranscriptionTest(
  "transcription-streaming",
  "transcription-short.wav",
  { validation: "type", expectedType: "string" },
  10000,
);

export const transcriptionVeryShort = createTranscriptionTest(
  "transcription-very-short",
  "transcription-short.m4a",
  { validation: "contains-all", contains: ["test"] },
  5000,
);

export const transcriptionCorrupted = createTranscriptionTest(
  "transcription-corrupted",
  "corrupted.mp3",
  { validation: "type", expectedType: "string" }, // May error or hang - SDK bug
  30000,
);

export const transcriptionCorruptedWav = createTranscriptionTest(
  "transcription-corrupted-wav",
  "corrupted.wav",
  { validation: "type", expectedType: "string" }, // May error or hang - SDK bug
  30000,
);

export const transcriptionTests = [
  transcriptionShortWav,
  transcriptionShortMp3,
  transcriptionAac,
  transcriptionM4a,
  transcriptionOgg,
  transcriptionSilence,
  transcriptionOnlyMusic,
  transcriptionLongAudio,
  transcriptionStreaming,
  transcriptionVeryShort,
  transcriptionCorrupted,
  transcriptionCorruptedWav,
];
