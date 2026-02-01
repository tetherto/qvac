// Real SDK tests
import type { TestDefinition } from "@tetherto/qvac-test-suite";
import { completionTests } from "./completion-tests.js";
import { transcriptionTests } from "./transcription-tests.js";
import { embeddingTests } from "./embedding-tests.js";
import { ragTests } from "./rag-tests.js";
import { translationTests } from "./translation-tests.js";
import { cacheTests } from "./cache-tests.js";
import { errorTests } from "./error-tests.js";
import { toolsTests } from "./tools-tests.js";
import { visionTests } from "./vision-tests.js";

// Model loading tests
export const modelLoadLlm: TestDefinition = {
  testId: "model-load-llm",
  params: { modelType: "llm", modelConstant: "LLAMA_3_2_1B_INST_Q4_0" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "model",
    dependency: "none",
    estimatedDurationMs: 60000,
  },
};

export const modelLoadEmbedding: TestDefinition = {
  testId: "model-load-embedding",
  params: { modelType: "embeddings", modelConstant: "GTE_LARGE_FP16" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "model",
    dependency: "none",
    estimatedDurationMs: 60000,
  },
};

export const modelLoadInvalid: TestDefinition = {
  testId: "model-load-invalid",
  params: {
    modelType: "llm",
    modelPath: "/invalid/path/nonexistent-model.gguf",
  },
  expectation: {
    validation: "throws-error",
    errorContains: "failed to locate",
  },
  metadata: {
    category: "model",
    dependency: "none",
    estimatedDurationMs: 5000,
  },
};

export const modelUnload: TestDefinition = {
  testId: "model-unload",
  params: { shouldClearStorage: false },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "model", dependency: "llm", estimatedDurationMs: 5000 },
};

export const modelLoadConcurrent: TestDefinition = {
  testId: "model-load-concurrent",
  params: {
    models: [
      { type: "llm", constant: "LLAMA_3_2_1B_INST_Q4_0" },
      { type: "embeddings", constant: "GTE_LARGE_FP16" },
    ],
  },
  expectation: { validation: "type", expectedType: "array" },
  metadata: {
    category: "model",
    dependency: "none",
    estimatedDurationMs: 120000,
    expectedCount: 2,
  },
};

export const modelReloadLlm: TestDefinition = {
  testId: "model-reload-llm",
  params: { modelType: "llm", modelConstant: "LLAMA_3_2_1B_INST_Q4_0" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "model",
    dependency: "llm",
    estimatedDurationMs: 15000,
  },
};

export const modelSwitchLlm: TestDefinition = {
  testId: "model-switch-llm",
  params: { currentModel: "llm", newModelConstant: "LLAMA_3_2_1B_INST_Q4_0" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "model",
    dependency: "llm",
    estimatedDurationMs: 90000,
  },
};

export const modelReloadAfterError: TestDefinition = {
  testId: "model-reload-after-error",
  params: { modelType: "llm", modelConstant: "LLAMA_3_2_1B_INST_Q4_0" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "model",
    dependency: "llm",
    estimatedDurationMs: 70000,
  },
};

// TODO placeholder tests
export const todoAddonDiscovery: TestDefinition = {
  testId: "todo-addon-discovery",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "todo", dependency: "none", estimatedDurationMs: 1000 },
};

export const todoAddonMetadata: TestDefinition = {
  testId: "todo-addon-metadata",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "todo", dependency: "none", estimatedDurationMs: 1000 },
};

export const todoLoadingProgress: TestDefinition = {
  testId: "todo-loading-progress",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "todo", dependency: "none", estimatedDurationMs: 1000 },
};

export const todoTypedErrorCodes: TestDefinition = {
  testId: "todo-typed-error-codes",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "todo", dependency: "none", estimatedDurationMs: 1000 },
};

export const todoAddonCrashDetection: TestDefinition = {
  testId: "todo-addon-crash-detection",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "todo", dependency: "none", estimatedDurationMs: 1000 },
};

// Export all tests as array
export const tests = [
  // Model tests (first section)
  modelLoadLlm,
  modelLoadEmbedding,
  modelLoadInvalid,
  modelUnload,
  modelLoadConcurrent,
  modelReloadLlm,

  // Completion tests
  ...completionTests,

  // Transcription tests
  ...transcriptionTests,

  // Embedding tests
  ...embeddingTests,

  // RAG tests
  ...ragTests,

  // Translation tests
  ...translationTests,

  // Cache tests
  ...cacheTests,

  // Error tests
  ...errorTests,

  // Tools tests
  ...toolsTests,

  // Vision tests (SKIPPED - see vision-tests.ts for details)
  ...visionTests,

  // Model tests (second section - duplicates like old structure)
  modelLoadLlm,
  modelLoadEmbedding,
  modelLoadInvalid,
  modelUnload,
  modelLoadConcurrent,
  modelReloadLlm,

  // Additional model tests
  modelSwitchLlm,
  modelReloadAfterError,

  // TODO placeholder tests
  todoAddonDiscovery,
  todoAddonMetadata,
  todoLoadingProgress,
  todoTypedErrorCodes,
  todoAddonCrashDetection,
];
