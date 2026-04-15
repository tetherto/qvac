import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const ttsChatterboxShortText: TestDefinition = {
  testId: "tts-chatterbox-short-text",
  params: { text: "Hello, how are you today?", stream: false },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "tts", dependency: "tts-chatterbox", estimatedDurationMs: 30000 },
};

export const ttsChatterboxMediumText: TestDefinition = {
  testId: "tts-chatterbox-medium-text",
  params: {
    text: "This is a test of the Chatterbox Text-to-Speech engine. It should generate high quality audio from this medium length text input.",
    stream: false,
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "tts", dependency: "tts-chatterbox", estimatedDurationMs: 45000 },
};

export const ttsChatterboxStreaming: TestDefinition = {
  testId: "tts-chatterbox-streaming",
  params: { text: "This is a streaming test for the Chatterbox engine.", stream: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "tts", dependency: "tts-chatterbox", estimatedDurationMs: 45000 },
};

export const ttsChatterboxEmptyTextError: TestDefinition = {
  testId: "tts-chatterbox-empty-text-error",
  params: { text: "", stream: false },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "tts", dependency: "tts-chatterbox", estimatedDurationMs: 10000 },
};

export const ttsSupertonicShortText: TestDefinition = {
  testId: "tts-supertonic-short-text",
  params: { text: "Hello, how are you today?", stream: false },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "tts", dependency: "tts-supertonic", estimatedDurationMs: 30000 },
};

export const ttsSupertonicMediumText: TestDefinition = {
  testId: "tts-supertonic-medium-text",
  params: {
    text: "This is a test of the Supertonic Text-to-Speech engine. It should generate high quality audio from this medium length text input.",
    stream: false,
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "tts", dependency: "tts-supertonic", estimatedDurationMs: 45000 },
};

export const ttsSupertonicStreaming: TestDefinition = {
  testId: "tts-supertonic-streaming",
  params: { text: "This is a streaming test for the Supertonic engine.", stream: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "tts", dependency: "tts-supertonic", estimatedDurationMs: 45000 },
};

export const ttsSupertonicEmptyTextError: TestDefinition = {
  testId: "tts-supertonic-empty-text-error",
  params: { text: "", stream: false },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "tts", dependency: "tts-supertonic", estimatedDurationMs: 10000 },
};

export const ttsSupertonicMultilingualText: TestDefinition = {
  testId: "tts-supertonic-multilingual-text",
  params: {
    text: "Hola mundo. Esta es una demostración de síntesis de voz con Supertonic en español.",
    stream: false,
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "tts", dependency: "tts-supertonic-multilingual", estimatedDurationMs: 45000 },
};

export const ttsTests = [
  ttsChatterboxShortText,
  ttsChatterboxMediumText,
  ttsChatterboxStreaming,
  ttsChatterboxEmptyTextError,
  ttsSupertonicShortText,
  ttsSupertonicMediumText,
  ttsSupertonicStreaming,
  ttsSupertonicEmptyTextError,
  ttsSupertonicMultilingualText,
];
