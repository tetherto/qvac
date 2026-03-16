// Real SDK tests
import type { TestDefinition } from "@tetherto/qvac-test-suite";
import { completionTests } from "./completion-tests.js";
import { transcriptionTests } from "./transcription-tests.js";
import { embeddingTests } from "./embedding-tests.js";
import { ragTests } from "./rag-tests.js";
import { translationTests } from "./translation-tests.js";
import { modelInfoTests } from "./model-info-tests.js";
import { kvCacheTests } from "./kv-cache-tests.js";
import { errorTests } from "./error-tests.js";
import { toolsTests } from "./tools-tests.js";
import { ocrTests } from "./ocr-tests.js";
import { ttsTests } from "./tts-tests.js";
import { configReloadTests } from "./config-reload-tests.js";
import { loggingTests } from "./logging-tests.js";
import { registryTests } from "./registry-tests.js";
import { nmtTests } from "./nmt-tests.js";
import { bergamotTests } from "./bergamot-tests.js";
import { shardedModelTests } from "./sharded-model-tests.js";
import { httpEmbeddingTests } from "./http-embedding-tests.js";
import { parakeetTests } from "./parakeet-tests.js";

// Model loading tests
export const modelLoadLlm: TestDefinition = {
  testId: "model-load-llm",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "model",
    dependency: "none",
    estimatedDurationMs: 60000,
  },
};

export const modelLoadEmbedding: TestDefinition = {
  testId: "model-load-embedding",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "model",
    dependency: "none",
    estimatedDurationMs: 60000,
  },
};

export const modelLoadOcr: TestDefinition = {
  testId: "model-load-ocr",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "model",
    dependency: "none",
    estimatedDurationMs: 90000,
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
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "model",
    dependency: "llm",
    estimatedDurationMs: 15000,
  },
};

export const modelSwitchLlm: TestDefinition = {
  testId: "model-switch-llm",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "model",
    dependency: "llm",
    estimatedDurationMs: 90000,
  },
};

export const modelReloadAfterError: TestDefinition = {
  testId: "model-reload-after-error",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "model",
    dependency: "llm",
    estimatedDurationMs: 70000,
  },
};


// Export all tests as array
export const tests = [
  // Model tests (first section)
  modelLoadLlm,
  modelLoadEmbedding,
  modelLoadOcr,
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

  // NMT tests
  ...nmtTests,

  // Bergamot tests
  ...bergamotTests,

  // Sharded model tests
  ...shardedModelTests,

  // HTTP embedding tests
  ...httpEmbeddingTests,

  // Model info tests
  ...modelInfoTests,

  // KV cache tests
  ...kvCacheTests,

  // Error tests
  ...errorTests,

  // Tools tests
  ...toolsTests,

  // OCR tests
  ...ocrTests,

  // TTS tests
  ...ttsTests,

  // Config reload tests
  ...configReloadTests,

  // Logging tests
  ...loggingTests,

  // Registry tests
  ...registryTests,

  // Parakeet transcription tests
  ...parakeetTests,

  // Additional model tests
  modelSwitchLlm,
  modelReloadAfterError,
];
