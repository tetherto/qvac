import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const shardedModelLoad: TestDefinition = {
  testId: "sharded-model-load",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: { category: "sharded-model", dependency: "none", estimatedDurationMs: 120000 },
};

export const shardedModelDetection: TestDefinition = {
  testId: "sharded-model-detection",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: { category: "sharded-model", dependency: "none", estimatedDurationMs: 120000 },
};

export const shardedModelHashValidation: TestDefinition = {
  testId: "sharded-model-hash-validation",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "sharded-model", dependency: "none", estimatedDurationMs: 120000 },
};

export const shardedModelBackwardCompatibility: TestDefinition = {
  testId: "sharded-model-backward-compatibility",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "sharded-model", dependency: "none", estimatedDurationMs: 60000 },
};

export const shardedModelProgress: TestDefinition = {
  testId: "sharded-model-progress",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "sharded-model", dependency: "none", estimatedDurationMs: 120000 },
};

export const shardedModelResume: TestDefinition = {
  testId: "sharded-model-resume",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "sharded-model", dependency: "none", estimatedDurationMs: 180000 },
};

export const shardedModelCancellation: TestDefinition = {
  testId: "sharded-model-cancellation",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "sharded-model", dependency: "none", estimatedDurationMs: 60000 },
};

export const shardedModelInference: TestDefinition = {
  testId: "sharded-model-inference",
  params: { text: "This is a test sentence for embedding generation using a sharded model." },
  expectation: { validation: "type", expectedType: "array" },
  suites: ["smoke"],
  metadata: { category: "sharded-model", dependency: "sharded-embeddings", estimatedDurationMs: 45000 },
};

export const shardedModelBatchInference: TestDefinition = {
  testId: "sharded-model-batch-inference",
  params: {
    texts: [
      "First test sentence for batch embedding.",
      "Second test sentence for batch embedding.",
      "Third test sentence for batch embedding.",
    ],
  },
  expectation: { validation: "type", expectedType: "array" },
  metadata: { category: "sharded-model", dependency: "sharded-embeddings", estimatedDurationMs: 60000 },
};

export const shardedModelLongTextInference: TestDefinition = {
  testId: "sharded-model-long-text-inference",
  params: { text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20) },
  expectation: { validation: "type", expectedType: "array" },
  metadata: { category: "sharded-model", dependency: "sharded-embeddings", estimatedDurationMs: 50000 },
};

export const shardedModelTests = [
  shardedModelLoad,
  shardedModelDetection,
  shardedModelHashValidation,
  shardedModelBackwardCompatibility,
  shardedModelProgress,
  shardedModelResume,
  shardedModelCancellation,
  shardedModelInference,
  shardedModelBatchInference,
  shardedModelLongTextInference,
];
