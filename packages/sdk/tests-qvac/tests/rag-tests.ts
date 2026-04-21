// RAG test definitions
import type { TestDefinition } from "@tetherto/qvac-test-suite";

const createRagTest = (
  testId: string,
  params: {
    workspace: string;
    documentContent?: string;
    documentFile?: string;
    chunkSize: number;
    chunkOverlap: number;
    chunkStrategy?: string;
  },
  suites?: string[],
): TestDefinition => ({
  testId,
  params,
  expectation: { validation: "type", expectedType: "string" }, // Returns success message or result object
  ...(suites && { suites }),
  metadata: {
    category: "rag",
    dependency: "embeddings",
    estimatedDurationMs: 10000,
  },
});

export const ragEmbeddingsSmall = createRagTest("rag-embeddings-small-chunks", {
  workspace: "test-small",
  documentContent:
    "This is a test document for RAG embeddings with small chunk size.",
  chunkSize: 50,
  chunkOverlap: 10,
  chunkStrategy: "paragraph",
}, ["smoke"]);

export const ragEmbeddingsMedium = createRagTest(
  "rag-embeddings-medium-chunks",
  {
    workspace: "test-medium",
    documentContent:
      "This is a longer test document for RAG embeddings with medium chunk size. It contains multiple sentences to test the chunking strategy.",
    chunkSize: 100,
    chunkOverlap: 20,
    chunkStrategy: "paragraph",
  },
);

export const ragEmbeddingsLarge = createRagTest("rag-embeddings-large-chunks", {
  workspace: "test-large",
  documentContent:
    "This is an even longer test document for RAG embeddings with large chunk size. It contains multiple paragraphs and sentences to properly test the chunking strategy with larger chunks. The RAG system should be able to handle this size efficiently.",
  chunkSize: 350,
  chunkOverlap: 70,
  chunkStrategy: "paragraph",
});

export const ragChunk50Overlap10 = createRagTest(
  "rag-embeddings-chunk-50-overlap-10",
  {
    workspace: "test",
    documentContent: "sample text content for chunking",
    chunkSize: 50,
    chunkOverlap: 10,
    chunkStrategy: "paragraph",
  },
);

export const ragChunk100Overlap20 = createRagTest(
  "rag-embeddings-chunk-100-overlap-20",
  {
    workspace: "test",
    documentContent: "sample text content for chunking",
    chunkSize: 100,
    chunkOverlap: 20,
    chunkStrategy: "paragraph",
  },
);

export const ragChunk200Overlap50 = createRagTest(
  "rag-embeddings-chunk-200-overlap-50",
  {
    workspace: "test",
    documentContent: "sample text content for chunking",
    chunkSize: 200,
    chunkOverlap: 50,
    chunkStrategy: "paragraph",
  },
);

export const ragChunk350Overlap70 = createRagTest(
  "rag-embeddings-chunk-350-overlap-70",
  {
    workspace: "test",
    documentContent: "sample text content for chunking",
    chunkSize: 350,
    chunkOverlap: 70,
    chunkStrategy: "paragraph",
  },
);

// questionable test - might be a bug in the SDK. At least currently it throws overflow error.
export const ragLargeDocument: TestDefinition = {
  testId: "rag-large-document-32kb",
  params: {
    workspace: "desert-adventure",
    documentFile: "desert_adventure_large.txt",
    chunkSize: 400,
    chunkOverlap: 80,
    chunkStrategy: "paragraph",
  },
  expectation: { validation: "throws-error", errorContains: "context overflow" },
  suites: ["smoke"],
  metadata: { category: "rag", dependency: "embeddings", estimatedDurationMs: 120000 },
};

export const ragMediumDocument = createRagTest("rag-medium-document-10kb", {
  workspace: "hiking-guide",
  documentFile: "mountain_hiking_guide.txt",
  chunkSize: 350,
  chunkOverlap: 70,
  chunkStrategy: "paragraph",
}, ["smoke"]);

export const ragTests = [
  ragEmbeddingsSmall,
  ragEmbeddingsMedium,
  ragEmbeddingsLarge,
  ragChunk50Overlap10,
  ragChunk100Overlap20,
  ragChunk200Overlap50,
  ragChunk350Overlap70,
  ragLargeDocument,
  ragMediumDocument,
];
