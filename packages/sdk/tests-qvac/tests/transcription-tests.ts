// Transcription test definitions
import type { TestDefinition } from "@tetherto/qvac-test-suite";

const createTranscriptionTest = (
  testId: string,
  audioFileName: string,
  expectation:
    | { validation: "contains-all" | "contains-any"; contains: string[] }
    | {
        validation: "type";
        expectedType: "string" | "number" | "array";
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

export const transcriptionCorrupted: TestDefinition = {
  testId: "transcription-corrupted",
  params: { audioFileName: "corrupted.mp3" },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: { category: "transcription", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const transcriptionCorruptedWav: TestDefinition = {
  testId: "transcription-corrupted-wav",
  params: { audioFileName: "corrupted.wav" },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: { category: "transcription", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const transcriptionWithPrompt: TestDefinition = {
  testId: "transcription-with-prompt",
  params: {
    audioFileName: "transcription-short.wav",
    prompt: "This is a test recording about QVAC SDK automation testing.",
  },
  expectation: { validation: "contains-any", contains: ["test", "QVAC"] },
  metadata: { category: "transcription", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const transcriptionPromptTechnical: TestDefinition = {
  testId: "transcription-prompt-technical",
  params: {
    audioFileName: "transcription-short.wav",
    prompt: "Technical terms: SDK, API, TypeScript, JavaScript, QVAC, Whisper, transcription.",
  },
  expectation: { validation: "contains-any", contains: ["test"] },
  metadata: { category: "transcription", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const transcriptionPromptPunctuation: TestDefinition = {
  testId: "transcription-prompt-punctuation",
  params: {
    audioFileName: "transcription-short.wav",
    prompt: "Use proper punctuation. Include periods, commas, and question marks.",
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "transcription", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const transcriptionWithoutPrompt: TestDefinition = {
  testId: "transcription-without-prompt",
  params: {
    audioFileName: "transcription-short.wav",
    prompt: null,
  },
  expectation: { validation: "contains-any", contains: ["test"] },
  metadata: { category: "transcription", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const transcriptionPromptEmpty: TestDefinition = {
  testId: "transcription-prompt-empty",
  params: {
    audioFileName: "transcription-short.wav",
    prompt: "",
  },
  expectation: { validation: "contains-any", contains: ["test"] },
  metadata: { category: "transcription", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const transcriptionTests = [
  transcriptionShortWav,
  transcriptionShortMp3,
  transcriptionAac,
  transcriptionOgg,
  transcriptionSilence,
  transcriptionStreaming,
  transcriptionVeryShort,
  transcriptionM4a,
  transcriptionCorrupted,
  transcriptionCorruptedWav,
  transcriptionWithPrompt,
  transcriptionPromptTechnical,
  transcriptionPromptPunctuation,
  transcriptionWithoutPrompt,
  transcriptionPromptEmpty,
];
