// Error handling test definitions
import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const errorCompletionNegativeTemperature: TestDefinition = {
  testId: "error-completion-negative-temperature",
  params: {
    history: [{ role: "user", content: "Test" }],
    stream: false,
    temperature: -0.5,
  },
  expectation: { validation: "type", expectedType: "string" }, // SDK should handle or error
  metadata: { category: "error", dependency: "llm", estimatedDurationMs: 3000 },
};

export const errorCompletionExcessiveTemperature: TestDefinition = {
  testId: "error-completion-excessive-temperature",
  params: {
    history: [{ role: "user", content: "Test" }],
    stream: false,
    temperature: 3.0,
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "error", dependency: "llm", estimatedDurationMs: 3000 },
};

export const errorCompletionInvalidTopP: TestDefinition = {
  testId: "error-completion-invalid-topp",
  params: {
    history: [{ role: "user", content: "Test" }],
    stream: false,
    topP: 1.5,
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "error", dependency: "llm", estimatedDurationMs: 3000 },
};

export const errorCompletionNegativeMaxTokens: TestDefinition = {
  testId: "error-completion-negative-maxtokens",
  params: {
    history: [{ role: "user", content: "Test" }],
    stream: false,
    maxTokens: -10,
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "error", dependency: "llm", estimatedDurationMs: 3000 },
};

export const errorEmbeddingEmptyInput: TestDefinition = {
  testId: "error-embedding-empty-input",
  params: { text: " " }, // SDK rejects truly empty with Zod
  expectation: { validation: "type", expectedType: "string" }, // Should handle or error gracefully
  metadata: {
    category: "error",
    dependency: "embedding",
    estimatedDurationMs: 3000,
  },
};

export const errorUseUnloadedModel: TestDefinition = {
  testId: "error-use-unloaded-model",
  params: {
    modelIdOverride: "unloaded-model-id-12345",
    history: [{ role: "user", content: "Test" }],
    stream: false,
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "error", dependency: "llm", estimatedDurationMs: 3000 },
};

export const errorRagUnloadedModel: TestDefinition = {
  testId: "error-rag-unloaded-model",
  params: {
    modelIdOverride: "unloaded-embedding-model-xyz",
    documentFile: "ocean_waves_poem.txt",
    chunkSize: 200,
    chunkOverlap: 50,
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "error",
    dependency: "embedding",
    estimatedDurationMs: 3000,
  },
};

export const errorTests = [
  errorCompletionNegativeTemperature,
  errorCompletionExcessiveTemperature,
  errorCompletionInvalidTopP,
  errorCompletionNegativeMaxTokens,
  errorEmbeddingEmptyInput,
  errorUseUnloadedModel,
  errorRagUnloadedModel,
];
