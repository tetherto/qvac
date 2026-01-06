// Cache management test definitions
import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const cacheGetModelInfo: TestDefinition = {
  testId: "cache-get-model-info",
  params: { modelConstant: "LLAMA_3_2_1B_INST_Q4_0" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "cache", dependency: "llm", estimatedDurationMs: 5000 },
};

export const cacheDeleteAll: TestDefinition = {
  testId: "cache-delete-all",
  params: { deleteAll: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "cache",
    dependency: "none",
    estimatedDurationMs: 10000,
  },
};

export const cacheDeleteByKey: TestDefinition = {
  testId: "cache-delete-by-key",
  params: { kvCacheKey: "test-session-cache" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "cache",
    dependency: "none",
    estimatedDurationMs: 5000,
  },
};

export const cacheDeleteByModel: TestDefinition = {
  testId: "cache-delete-by-model",
  params: { kvCacheKey: "test-session", modelIdToDelete: "specific-model-id" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "cache",
    dependency: "none",
    estimatedDurationMs: 5000,
  },
};

export const cacheConfigDirectory: TestDefinition = {
  testId: "cache-config-directory",
  params: { cacheDirectory: "/tmp/qvac-test-cache" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "cache",
    dependency: "none",
    estimatedDurationMs: 5000,
  },
};

export const cacheVerifyFiles: TestDefinition = {
  testId: "cache-verify-files",
  params: { modelConstant: "LLAMA_3_2_1B_INST_Q4_0" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "cache", dependency: "llm", estimatedDurationMs: 5000 },
};

export const cacheHypercoreDeletion: TestDefinition = {
  testId: "cache-hypercore-deletion",
  params: { kvCacheKey: "test-hypercore-delete" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "cache",
    dependency: "none",
    estimatedDurationMs: 5000,
  },
};

export const cacheMultipleModels: TestDefinition = {
  testId: "cache-multiple-models-info",
  params: { models: ["LLAMA_3_2_1B_INST_Q4_0", "GTE_LARGE_FP16"] },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "cache",
    dependency: "embedding",
    estimatedDurationMs: 10000,
  },
};

export const cacheAfterUnload: TestDefinition = {
  testId: "cache-persists-after-unload",
  params: { modelConstant: "LLAMA_3_2_1B_INST_Q4_0" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "cache", dependency: "llm", estimatedDurationMs: 5000 },
};

export const cacheInvalidKey: TestDefinition = {
  testId: "cache-invalid-key-error",
  params: { kvCacheKey: "" },
  expectation: { validation: "type", expectedType: "string" }, // Should handle gracefully
  metadata: { category: "cache", dependency: "llm", estimatedDurationMs: 1000 },
};

export const cacheTests = [
  cacheGetModelInfo,
  cacheDeleteAll,
  cacheDeleteByKey,
  cacheDeleteByModel,
  cacheConfigDirectory,
  cacheVerifyFiles,
  cacheHypercoreDeletion,
  cacheMultipleModels,
  cacheAfterUnload,
  cacheInvalidKey,
];
