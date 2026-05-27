import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const errorInvalidModelId: TestDefinition = {
  testId: "error-invalid-model-id",
  params: { modelId: "nonexistent-model-id-12345", operation: "embed" },
  expectation: { validation: "throws-error", errorContains: "" },
  suites: ["smoke"],
  metadata: { category: "error", dependency: "embeddings", estimatedDurationMs: 5000 },
};

export const errorInvalidResponseType: TestDefinition = {
  testId: "error-invalid-response-type",
  params: { verifyErrorCodes: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "error", dependency: "none", estimatedDurationMs: 2000 },
};

export const errorModelLoadFailed: TestDefinition = {
  testId: "error-model-load-failed",
  params: { modelPath: "/invalid/path/to/model.gguf", modelType: "llm" },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: { category: "error", dependency: "none", estimatedDurationMs: 5000 },
};

export const errorDeleteCacheInvalidParams: TestDefinition = {
  testId: "error-delete-cache-invalid-params",
  params: { invalidParams: true },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: { category: "error", dependency: "none", estimatedDurationMs: 5000 },
};

export const errorStructuredErrorCode: TestDefinition = {
  testId: "error-structured-error-code",
  params: { verifyErrorCodes: true },
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: { category: "error", dependency: "none", estimatedDurationMs: 2000 },
};

export const errorChainingCause: TestDefinition = {
  testId: "error-chaining-cause",
  params: { triggerChainedError: true },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: { category: "error", dependency: "none", estimatedDurationMs: 5000 },
};

export const errorRagOperationFailed: TestDefinition = {
  testId: "error-rag-operation-failed",
  params: { modelId: "nonexistent-model", query: "test query" },
  expectation: { validation: "throws-error", errorContains: "" },
  suites: ["smoke"],
  metadata: { category: "error", dependency: "embeddings", estimatedDurationMs: 5000 },
};

export const errorTranscriptionFailed: TestDefinition = {
  testId: "error-transcription-failed",
  params: { audioPath: "/nonexistent/audio/file.wav" },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: { category: "error", dependency: "whisper", estimatedDurationMs: 5000 },
};

export const errorCompletionNegativeTemperature: TestDefinition = {
  testId: "error-completion-negative-temperature",
  params: { history: [{ role: "user", content: "Test" }], stream: false, temperature: -0.5 },
  expectation: { validation: "throws-error", errorContains: "" },
  suites: ["smoke"],
  metadata: { category: "error", dependency: "llm", estimatedDurationMs: 3000 },
};

export const errorCompletionExcessiveTemperature: TestDefinition = {
  testId: "error-completion-excessive-temperature",
  params: { history: [{ role: "user", content: "Test" }], stream: false, temperature: 3.0 },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: { category: "error", dependency: "llm", estimatedDurationMs: 3000 },
};

export const errorCompletionInvalidTopP: TestDefinition = {
  testId: "error-completion-invalid-topp",
  params: { history: [{ role: "user", content: "Test" }], stream: false, topP: 1.5 },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: { category: "error", dependency: "llm", estimatedDurationMs: 3000 },
};

export const errorCompletionNegativeMaxTokens: TestDefinition = {
  testId: "error-completion-negative-maxtokens",
  params: { history: [{ role: "user", content: "Test" }], stream: false, maxTokens: -10 },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: { category: "error", dependency: "llm", estimatedDurationMs: 3000 },
};

export const errorEmbeddingEmptyInput: TestDefinition = {
  testId: "error-embedding-empty-input",
  params: { text: " " },
  expectation: { validation: "type", expectedType: "array" },
  metadata: { category: "error", dependency: "embeddings", estimatedDurationMs: 3000 },
};

export const errorUseUnloadedModel: TestDefinition = {
  testId: "error-use-unloaded-model",
  params: { modelIdOverride: "unloaded-model-id-12345", history: [{ role: "user", content: "Test" }], stream: false },
  expectation: { validation: "throws-error", errorContains: "" },
  suites: ["smoke"],
  metadata: { category: "error", dependency: "llm", estimatedDurationMs: 3000 },
};

export const errorRagUnloadedModel: TestDefinition = {
  testId: "error-rag-unloaded-model",
  params: { modelIdOverride: "unloaded-embedding-model-xyz", documentFile: "ocean_waves_poem.txt", chunkSize: 200, chunkOverlap: 50 },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: { category: "error", dependency: "embeddings", estimatedDurationMs: 3000 },
};

export const errorTests = [
  errorInvalidModelId,
  errorInvalidResponseType,
  errorModelLoadFailed,
  errorDeleteCacheInvalidParams,
  errorStructuredErrorCode,
  errorChainingCause,
  errorRagOperationFailed,
  errorTranscriptionFailed,
  errorCompletionNegativeTemperature,
  errorCompletionExcessiveTemperature,
  errorCompletionInvalidTopP,
  errorCompletionNegativeMaxTokens,
  errorEmbeddingEmptyInput,
  errorUseUnloadedModel,
  errorRagUnloadedModel,
];
