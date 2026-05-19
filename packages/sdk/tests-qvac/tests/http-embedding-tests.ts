import type { TestDefinition } from "@tetherto/qvac-test-suite";

const SHARDED_URL =
  "https://huggingface.co/opaninakuffo/gte-large-fp16-sharded/resolve/main/gte-large_fp16-00003-of-00005.gguf";
const ARCHIVE_URL =
  "https://huggingface.co/opaninakuffo/gte-large-fp16-sharded-tgz/resolve/main/gte-large_fp16.tgz";

export const httpShardedEmbedLoad: TestDefinition = {
  testId: "http-sharded-embed-load",
  params: { modelType: "embeddings", modelUrl: SHARDED_URL },
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: { category: "http", dependency: "none", estimatedDurationMs: 300000 },
};

export const httpShardedEmbedProgress: TestDefinition = {
  testId: "http-sharded-embed-progress",
  params: { modelType: "embeddings", modelUrl: SHARDED_URL, trackProgress: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "http", dependency: "none", estimatedDurationMs: 120000 },
};

export const httpShardedEmbedInference: TestDefinition = {
  testId: "http-sharded-embed-inference",
  params: {
    modelType: "embeddings",
    modelUrl: SHARDED_URL,
    text: "This is a test sentence for embedding generation using an HTTP sharded model.",
  },
  expectation: { validation: "type", expectedType: "array" },
  suites: ["smoke"],
  metadata: { category: "http", dependency: "none", estimatedDurationMs: 300000 },
};

export const httpArchiveEmbedLoad: TestDefinition = {
  testId: "http-archive-embed-load",
  params: { modelType: "embeddings", modelUrl: ARCHIVE_URL },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "http", dependency: "none", estimatedDurationMs: 300000 },
};

export const httpArchiveEmbedProgress: TestDefinition = {
  testId: "http-archive-embed-progress",
  params: { modelType: "embeddings", modelUrl: ARCHIVE_URL, trackProgress: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "http", dependency: "none", estimatedDurationMs: 300000 },
};

export const httpArchiveEmbedInference: TestDefinition = {
  testId: "http-archive-embed-inference",
  params: {
    modelType: "embeddings",
    modelUrl: ARCHIVE_URL,
    text: "This is a test sentence for embedding generation using an HTTP archive model.",
  },
  expectation: { validation: "type", expectedType: "array" },
  metadata: { category: "http", dependency: "none", estimatedDurationMs: 300000 },
};

export const httpEmbeddingTests = [
  httpShardedEmbedLoad,
  httpShardedEmbedProgress,
  httpShardedEmbedInference,
  httpArchiveEmbedLoad,
  httpArchiveEmbedProgress,
  httpArchiveEmbedInference,
];
