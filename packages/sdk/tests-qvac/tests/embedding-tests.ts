// Embedding test definitions
import type { TestDefinition } from "@tetherto/qvac-test-suite";

const createEmbeddingTest = (
  testId: string,
  params: { text?: string; codeFile?: string },
  minDimensions: number = 128,
  suites?: string[],
): TestDefinition => ({
  testId,
  params,
  expectation: { validation: "type", expectedType: "array" },
  ...(suites && { suites }),
  metadata: {
    category: "embedding",
    dependency: "embeddings",
    estimatedDurationMs: 5000,
  },
});

export const embedSimpleText = createEmbeddingTest(
  "embed-simple-text",
  { text: "Hello world, this is a test of text embedding." },
  100,
  ["smoke"],
);

export const embedLongText = createEmbeddingTest(
  "embed-long-text",
  {
    text: "Artificial intelligence and machine learning are transforming how we interact with technology. ".repeat(
      10,
    ),
  },
  100,
);

export const embedEmptyText = createEmbeddingTest("embed-empty-text", {
  text: " ",
}); // SDK rejects truly empty

export const embedUnicode = createEmbeddingTest(
  "embed-unicode",
  { text: "Hello 👋 World 🌍 Testing émojis and ñ special çharacters 你好" },
  100,
);

export const embedVeryShort = createEmbeddingTest(
  "embed-very-short",
  { text: "Hi" },
  100,
);

export const embedCodeSnippet = createEmbeddingTest("embed-code-snippet", {
  text: "function hello() { console.log('Hello World'); return true; }",
});

export const embedMultilingual = createEmbeddingTest("embed-multilingual", {
  text: "Hello world. Bonjour le monde. Hola mundo. こんにちは世界",
});

export const embedSpecialChars = createEmbeddingTest("embed-special-chars", {
  text: "@#$%^&*()_+{}|:<>?[]\\;',./`~!",
});

export const embedNumbersOnly = createEmbeddingTest("embed-numbers-only", {
  text: "1234567890 42 3.14159 999",
});

// Batch and similarity tests
export const embedBatch: TestDefinition = {
  testId: "embed-batch",
  params: {
    texts: [
      "First text to embed",
      "Second text to embed",
      "Third text to embed",
    ],
  },
  expectation: { validation: "type", expectedType: "array" },
  suites: ["smoke"],
  metadata: {
    category: "embedding",
    dependency: "embeddings",
    estimatedDurationMs: 10000,
  },
};

export const embedSimilarity: TestDefinition = {
  testId: "embed-similarity",
  params: {
    text: "The cat sits on the mat.",
  },
  expectation: { validation: "type", expectedType: "array" },
  metadata: {
    category: "embedding",
    dependency: "embeddings",
    estimatedDurationMs: 10000,
  },
};

export const embedSemanticSimilarity: TestDefinition = {
  testId: "embed-semantic-similarity",
  params: {
    text: "Semantic similarity test text",
  },
  expectation: { validation: "type", expectedType: "array" },
  metadata: {
    category: "embedding",
    dependency: "embeddings",
    estimatedDurationMs: 10000,
  },
};

export const embeddingTests = [
  embedSimpleText,
  embedLongText,
  embedEmptyText,
  embedSimilarity,
  embedBatch,
  embedUnicode,
  embedVeryShort,
  embedCodeSnippet,
  embedMultilingual,
  embedSpecialChars,
  embedNumbersOnly,
  embedSemanticSimilarity,
];
