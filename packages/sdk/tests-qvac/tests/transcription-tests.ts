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
  suites?: string[],
): TestDefinition => ({
  testId,
  params: { audioFileName, timeout: 300000 },
  expectation,
  ...(suites && { suites }),
  metadata: {
    category: "transcription",
    dependency: "whisper",
    estimatedDurationMs,
  },
});

export const transcriptionShortWav = createTranscriptionTest(
  "transcription-short-wav",
  "transcription-short-wav.wav",
  {
    validation: "contains-all",
    contains: ["test", "automation"],
  },
  30000,
  ["smoke"],
);

export const transcriptionShortMp3 = createTranscriptionTest(
  "transcription-short-mp3",
  "transcription-short-mp3.mp3",
  {
    validation: "contains-all",
    contains: ["test", "automation"],
  },
  30000,
  ["smoke"],
);

export const transcriptionShortAac = createTranscriptionTest(
  "transcription-short-aac",
  "transcription-short-aac.aac",
  {
    validation: "contains-all",
    contains: ["test", "automation"],
  },
);

export const transcriptionShortM4a = createTranscriptionTest(
  "transcription-short-m4a",
  "transcription-short-m4a.m4a",
  {
    validation: "contains-all",
    contains: ["test"],
  },
);

export const transcriptionShortOgg = createTranscriptionTest(
  "transcription-short-ogg",
  "transcription-short-ogg.ogg",
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
  "transcription-short-wav.wav",
  { validation: "type", expectedType: "string" },
  10000,
  ["smoke"],
);

export const transcriptionVeryShort = createTranscriptionTest(
  "transcription-very-short",
  "transcription-short-m4a.m4a",
  { validation: "contains-all", contains: ["test"] },
  5000,
);

export const transcriptionCorruptedMp3: TestDefinition = {
  testId: "transcription-corrupted-mp3",
  params: { audioFileName: "corrupted-mp3.mp3" },
  expectation: { validation: "throws-error", errorContains: "" },
  suites: ["smoke"],
  metadata: { category: "transcription", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const transcriptionCorruptedWav: TestDefinition = {
  testId: "transcription-corrupted-wav",
  params: { audioFileName: "corrupted-wav.wav" },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: { category: "transcription", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const transcriptionWithPrompt: TestDefinition = {
  testId: "transcription-with-prompt",
  params: {
    audioFileName: "transcription-short-wav.wav",
    prompt: "This is a test recording about QVAC SDK automation testing.",
  },
  expectation: { validation: "contains-any", contains: ["test", "QVAC"] },
  suites: ["smoke"],
  metadata: { category: "transcription", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const transcriptionPromptTechnical: TestDefinition = {
  testId: "transcription-prompt-technical",
  params: {
    audioFileName: "transcription-short-wav.wav",
    prompt: "Technical terms: SDK, API, TypeScript, JavaScript, QVAC, Whisper, transcription.",
  },
  expectation: { validation: "contains-any", contains: ["test"] },
  metadata: { category: "transcription", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const transcriptionPromptPunctuation: TestDefinition = {
  testId: "transcription-prompt-punctuation",
  params: {
    audioFileName: "transcription-short-wav.wav",
    prompt: "Use proper punctuation. Include periods, commas, and question marks.",
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "transcription", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const transcriptionWithoutPrompt: TestDefinition = {
  testId: "transcription-without-prompt",
  params: {
    audioFileName: "transcription-short-wav.wav",
    prompt: null,
  },
  expectation: { validation: "contains-any", contains: ["test"] },
  metadata: { category: "transcription", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const transcriptionPromptEmpty: TestDefinition = {
  testId: "transcription-prompt-empty",
  params: {
    audioFileName: "transcription-short-wav.wav",
    prompt: "",
  },
  expectation: { validation: "contains-any", contains: ["test"] },
  metadata: { category: "transcription", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const transcriptionTests = [
  transcriptionShortWav,
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
];
