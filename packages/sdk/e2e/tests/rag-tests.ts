// RAG test definitions
import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * Ingests one document and checks that chunks came back.
 *
 * The workspace is deleted afterwards whether the body passed or not. The
 * executor never did this -- it disambiguated instead, suffixing the workspace
 * with the embedding model's id so runs against different models could not mix
 * -- but a workspace that is gone by the end cannot collide with anything, and
 * leaving state behind is what made the suffix necessary in the first place.
 */
const ingestSteps = (document: string): Step[] => [
  { useModel: { deps: ['embeddings'], as: 'model' } },
  {
    call: {
      method: 'ragIngest',
      params: {
        modelId: '$model',
        workspace: '$params.workspace',
        documents: [document],
        chunk: true,
        chunkOpts: {
          chunkSize: '$params.chunkSize',
          chunkOverlap: '$params.chunkOverlap',
          chunkStrategy: '$params.chunkStrategy?'
        }
      },
      as: 'ingested'
    }
  },
  { project: { from: '$ingested', path: 'processed', as: 'processed' } },
  { assert: { on: '$processed', named: 'lengthAtLeast', with: { length: 1 } } }
]

/**
 * Removes the workspace the body created, on both paths.
 *
 * Closed before deleted: ingest leaves the workspace open, and the engine
 * refuses to delete one that is still in use.
 */
const deleteWorkspace: Step[] = [
  { call: { method: 'ragCloseWorkspace', params: { workspace: '$params.workspace' } } },
  { call: { method: 'ragDeleteWorkspace', params: { workspace: '$params.workspace' } } }
]

const createRagTest = (
  testId: string,
  params: {
    workspace: string
    documentContent?: string
    documentFile?: string
    chunkSize: number
    chunkOverlap: number
    chunkStrategy?: string
  },
  suites?: string[],
  steps?: Step[]
): TestDefinition => ({
  testId,
  params,
  expectation: { validation: 'type', expectedType: 'string' }, // Returns success message or result object
  ...(suites && { suites }),
  steps: steps ?? ingestSteps(params.documentContent ?? ''),
  finally: deleteWorkspace,
  metadata: {
    category: 'rag',
    dependency: 'embeddings',
    estimatedDurationMs: 10000
  }
})

export const ragEmbeddingsSmall = createRagTest(
  'rag-embeddings-small-chunks',
  {
    workspace: 'test-small',
    documentContent: 'This is a test document for RAG embeddings with small chunk size.',
    chunkSize: 50,
    chunkOverlap: 10,
    chunkStrategy: 'paragraph'
  },
  ['smoke']
)

export const ragEmbeddingsMedium = createRagTest('rag-embeddings-medium-chunks', {
  workspace: 'test-medium',
  documentContent:
    'This is a longer test document for RAG embeddings with medium chunk size. It contains multiple sentences to test the chunking strategy.',
  chunkSize: 100,
  chunkOverlap: 20,
  chunkStrategy: 'paragraph'
})

export const ragEmbeddingsLarge = createRagTest('rag-embeddings-large-chunks', {
  workspace: 'test-large',
  documentContent:
    'This is an even longer test document for RAG embeddings with large chunk size. It contains multiple paragraphs and sentences to properly test the chunking strategy with larger chunks. The RAG system should be able to handle this size efficiently.',
  chunkSize: 350,
  chunkOverlap: 70,
  chunkStrategy: 'paragraph'
})

/**
 * Not migrated, and deliberately so.
 *
 * The other RAG tests are SDK calls; this one also writes an adapter marker
 * into the workspace directory before ingesting and then reads the TurboVec
 * checkpoint tree off disk to decide whether a manifest was written. Those are
 * filesystem facts about where the engine puts its data, not calls through the
 * client's public surface, so there is nothing here for a second client to
 * reproduce -- a declarative body would have to invent a step for "look at
 * this directory", which is exactly the kind of escape hatch that would let
 * any test claim anything.
 */
export const ragTurboVecIngestSearch: TestDefinition = {
  testId: 'rag-turbovec-ingest-search',
  params: {
    workspace: 'turbovec-e2e',
    documentContent: 'The verification code is ORANGE-742.',
    secondDocumentContent: 'A blue whale is the largest animal on Earth.',
    searchQuery: 'What is the verification code?',
    chunkSize: 100,
    chunkOverlap: 20,
    chunkStrategy: 'paragraph',
    adapter: 'turbovec'
  },
  expectation: {
    validation: 'contains-all',
    contains: ['ORANGE-742', 'checkpoint:present']
  },
  suites: ['smoke'],
  metadata: { category: 'rag', dependency: 'embeddings', estimatedDurationMs: 30000 }
}

export const ragChunk50Overlap10 = createRagTest('rag-embeddings-chunk-50-overlap-10', {
  workspace: 'test',
  documentContent: 'sample text content for chunking',
  chunkSize: 50,
  chunkOverlap: 10,
  chunkStrategy: 'paragraph'
})

export const ragChunk100Overlap20 = createRagTest('rag-embeddings-chunk-100-overlap-20', {
  workspace: 'test',
  documentContent: 'sample text content for chunking',
  chunkSize: 100,
  chunkOverlap: 20,
  chunkStrategy: 'paragraph'
})

export const ragChunk200Overlap50 = createRagTest('rag-embeddings-chunk-200-overlap-50', {
  workspace: 'test',
  documentContent: 'sample text content for chunking',
  chunkSize: 200,
  chunkOverlap: 50,
  chunkStrategy: 'paragraph'
})

export const ragChunk350Overlap70 = createRagTest('rag-embeddings-chunk-350-overlap-70', {
  workspace: 'test',
  documentContent: 'sample text content for chunking',
  chunkSize: 350,
  chunkOverlap: 70,
  chunkStrategy: 'paragraph'
})

// questionable test - might be a bug in the SDK. At least currently it throws overflow error.
export const ragLargeDocument: TestDefinition = {
  testId: 'rag-large-document-32kb',
  params: {
    workspace: 'desert-adventure',
    documentFile: 'desert_adventure_large.txt',
    chunkSize: 400,
    chunkOverlap: 80,
    chunkStrategy: 'paragraph'
  },
  expectation: { validation: 'throws-error', errorContains: 'context overflow' },
  suites: ['smoke'],
  // The refusal is the claim here: 32 KB of text overflows the embedding
  // model's context, and the test exists to pin that it is reported rather
  // than silently truncated.
  steps: [
    { asset: { kind: 'document', file: '$params.documentFile', form: 'text', as: 'document' } },
    { useModel: { deps: ['embeddings'], as: 'model' } },
    {
      callError: {
        method: 'ragIngest',
        params: {
          modelId: '$model',
          workspace: '$params.workspace',
          documents: ['$document'],
          chunk: true,
          chunkOpts: {
            chunkSize: '$params.chunkSize',
            chunkOverlap: '$params.chunkOverlap',
            chunkStrategy: '$params.chunkStrategy'
          }
        },
        as: 'err'
      }
    },
    { project: { from: '$err', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ],
  finally: deleteWorkspace,
  metadata: { category: 'rag', dependency: 'embeddings', estimatedDurationMs: 120000 }
}

export const ragMediumDocument = createRagTest(
  'rag-medium-document-10kb',
  {
    workspace: 'hiking-guide',
    documentFile: 'mountain_hiking_guide.txt',
    chunkSize: 350,
    chunkOverlap: 70,
    chunkStrategy: 'paragraph'
  },
  ['smoke'],
  [
    { asset: { kind: 'document', file: '$params.documentFile', form: 'text', as: 'document' } },
    ...ingestSteps('$document')
  ]
)

export const ragTests = [
  ragEmbeddingsSmall,
  ragEmbeddingsMedium,
  ragEmbeddingsLarge,
  ragTurboVecIngestSearch,
  ragChunk50Overlap10,
  ragChunk100Overlap20,
  ragChunk200Overlap50,
  ragChunk350Overlap70,
  ragLargeDocument,
  ragMediumDocument
]
