import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const cancelMidStreamCompletion: TestDefinition = {
  testId: "cancel-mid-stream-completion",
  params: {
    prompt: "Tell me a long story about dragons, in many sentences.",
    cancelAfterTokens: 3,
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "completion",
    dependency: "llm",
    estimatedDurationMs: 20000,
  },
};

export const cancelBeforeBeginCompletion: TestDefinition = {
  testId: "cancel-before-begin-completion",
  params: {
    prompt: "Write a paragraph about the history of cryptography.",
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "completion",
    dependency: "llm",
    estimatedDurationMs: 20000,
  },
};

export const cancelThenResumeKvCache: TestDefinition = {
  testId: "cancel-then-resume-kv-cache",
  params: {
    cacheKey: "cancel-then-resume-kvcache",
    firstUserMessage: "Tell me a long story about wizards.",
    secondUserMessage: "Repeat this word: banana",
    expectedAnswerContains: "banana",
    cancelAfterTokens: 3,
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "completion",
    dependency: "llm",
    estimatedDurationMs: 30000,
  },
};

export const cancelBroadEmbeddings: TestDefinition = {
  testId: "cancel-broad-embeddings",
  params: {
    passageCount: 64,
    passageFiller:
      "machine learning natural language processing transformer architecture attention mechanism gradient descent ",
    passageFillerRepeats: 16,
    registryBeginGraceMs: 50,
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "cancellation",
    dependency: "embeddings",
    estimatedDurationMs: 30000,
  },
};

export const cancelBroadTranslateLlm: TestDefinition = {
  testId: "cancel-broad-translate-llm",
  params: {
    text:
      "Write a long, detailed, multi-paragraph essay about the history of artificial intelligence. " +
      "Include the early symbolic era, the AI winters, the deep-learning revival, and the rise of " +
      "large language models in the 2020s. Be thorough and use complete paragraphs.",
    from: "en",
    to: "es",
    maxTokensAfterCancel: 30,
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "cancellation",
    dependency: "llm",
    estimatedDurationMs: 30000,
  },
};

export const serializeConcurrentCompletion: TestDefinition = {
  testId: "serialize-concurrent-completion",
  params: {
    prompt: "Reply with one short sentence naming your favourite colour.",
  },
  expectation: { validation: "function", fn: () => true },
  suites: ["smoke"],
  metadata: {
    category: "cancellation",
    dependency: "llm",
    estimatedDurationMs: 30000,
  },
};

export const cancelByRequestIdEmbed: TestDefinition = {
  testId: "cancel-by-requestid-embed",
  params: {
    passageCount: 64,
    passageFiller:
      "machine learning natural language processing transformer architecture attention mechanism gradient descent ",
    passageFillerRepeats: 16,
    registryBeginGraceMs: 50,
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "cancellation",
    dependency: "embeddings",
    estimatedDurationMs: 30000,
  },
};

export const cancelByRequestIdTranscribe: TestDefinition = {
  testId: "cancel-by-requestid-transcribe",
  params: {
    audioFileName: "transcription-short-wav.wav",
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "cancellation",
    dependency: "whisper",
    estimatedDurationMs: 30000,
  },
};

export const cancelByRequestIdRagIngest: TestDefinition = {
  testId: "cancel-by-requestid-rag-ingest",
  params: {
    workspaceBase: "cancel-by-requestid",
    documentFiller:
      "The quick brown fox jumps over the lazy dog. Machine learning is a subset of artificial intelligence that enables computers to learn from data. Natural language processing combines linguistics and computer science to enable computers to understand human language. ",
    documentFillerRepeats: 100,
    chunkSize: 256,
    chunkOverlap: 32,
    registryBeginGraceMs: 200,
  },
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "cancellation",
    dependency: "embeddings",
    estimatedDurationMs: 30000,
  },
};

export const cancellationTests = [
  cancelMidStreamCompletion,
  cancelBeforeBeginCompletion,
  cancelThenResumeKvCache,
  cancelBroadEmbeddings,
  cancelBroadTranslateLlm,
  serializeConcurrentCompletion,
  cancelByRequestIdEmbed,
  cancelByRequestIdTranscribe,
  cancelByRequestIdRagIngest,
];
