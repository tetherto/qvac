import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const configReloadWhisperLanguage: TestDefinition = {
  testId: "config-reload-whisper-language",
  params: { newLanguage: "es" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "config-reload", dependency: "whisper", estimatedDurationMs: 15000 },
};

export const configReloadWhisperParams: TestDefinition = {
  testId: "config-reload-whisper-params",
  params: { newConfig: { language: "de", temperature: 0.2, suppress_blank: false } },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "config-reload", dependency: "whisper", estimatedDurationMs: 15000 },
};

export const configReloadPreservesId: TestDefinition = {
  testId: "config-reload-preserves-id",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "config-reload", dependency: "whisper", estimatedDurationMs: 15000 },
};

export const configReloadInvalidModelId: TestDefinition = {
  testId: "config-reload-invalid-model-id",
  params: { invalidModelId: "0000000000000000" },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: { category: "config-reload", dependency: "whisper", estimatedDurationMs: 5000 },
};

export const configReloadWrongModelType: TestDefinition = {
  testId: "config-reload-wrong-model-type",
  params: {},
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: { category: "config-reload", dependency: "whisper", estimatedDurationMs: 5000 },
};

export const configReloadThenTranscribe: TestDefinition = {
  testId: "config-reload-then-transcribe",
  params: { audioFileName: "transcription-short-wav.wav", newLanguage: "en" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "config-reload", dependency: "whisper", estimatedDurationMs: 30000 },
};

export const configReloadTests = [
  configReloadWhisperLanguage,
  configReloadWhisperParams,
  configReloadPreservesId,
  configReloadInvalidModelId,
  configReloadWrongModelType,
  configReloadThenTranscribe,
];
