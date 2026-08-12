import test from 'brittle'
import { IngestionService } from '../../src/services/IngestionService.js'
import { QvacErrorRAG, ERR_CODES } from '../../src/errors.js'
import type { EmbeddedDoc } from '../../src/types.js'

type IngestionServiceConfig = ConstructorParameters<typeof IngestionService>[0]

// Mock dependencies for IngestionService
function createMockDeps() {
  return {
    dbAdapter: {
      // lunte-disable-next-line require-await
      saveEmbeddings: async () => []
    },
    chunkingService: {
      // lunte-disable-next-line require-await
      chunkText: async () => []
    },
    embeddingService: {
      // lunte-disable-next-line require-await
      generateEmbeddings: async () => [0.1, 0.2, 0.3],
      // lunte-disable-next-line require-await
      generateEmbeddingsForDocs: async () => ({})
    }
  }
}

// Helper to create valid embedded doc
function createDoc(id: string, overrides: Record<string, unknown> = {}): EmbeddedDoc {
  return {
    id,
    content: `Content for ${id}`,
    embedding: [0.1, 0.2, 0.3],
    embeddingModelId: 'test-model',
    ...overrides
  } as EmbeddedDoc
}

test('IngestionService.saveEmbeddings: valid docs pass validation', async (t) => {
  const deps = createMockDeps()
  const service = new IngestionService(deps as unknown as IngestionServiceConfig)

  const docs = [createDoc('doc-1'), createDoc('doc-2'), createDoc('doc-3')]

  // Should not throw
  const result = await service.saveEmbeddings(docs)
  t.ok(Array.isArray(result), 'Should return result array')
})

test('IngestionService.saveEmbeddings: rejects empty array with QvacErrorRAG', async (t) => {
  const deps = createMockDeps()
  const service = new IngestionService(deps as unknown as IngestionServiceConfig)

  try {
    await service.saveEmbeddings([])
    t.fail('Should throw error for empty array')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Should throw QvacErrorRAG')
    if (err instanceof QvacErrorRAG) {
      t.is(err.code, ERR_CODES.INVALID_INPUT, 'Should have INVALID_INPUT error code')
      t.ok(err.message.includes('cannot be empty'), 'Error message should mention empty')
    }
  }
})

test('IngestionService.saveEmbeddings: requires embeddingModelId with QvacErrorRAG', async (t) => {
  const deps = createMockDeps()
  const service = new IngestionService(deps as unknown as IngestionServiceConfig)

  const docs = [
    createDoc('doc-1'),
    { id: 'doc-2', content: 'Test', embedding: [0.1, 0.2, 0.3] } as unknown as EmbeddedDoc // missing embeddingModelId
  ]

  try {
    await service.saveEmbeddings(docs)
    t.fail('Should throw error for missing embeddingModelId')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Should throw QvacErrorRAG')
    if (err instanceof QvacErrorRAG) {
      t.is(err.code, ERR_CODES.INVALID_INPUT, 'Should have INVALID_INPUT error code')
    }
  }
})

test('IngestionService.saveEmbeddings: rejects non-numeric embeddings with QvacErrorRAG', async (t) => {
  const deps = createMockDeps()
  const service = new IngestionService(deps as unknown as IngestionServiceConfig)

  const docs = [
    createDoc('doc-1'),
    createDoc('doc-2', { embedding: ['string', 0.2, 0.3] }) // non-number in embedding
  ]

  try {
    await service.saveEmbeddings(docs)
    t.fail('Should throw error for non-numeric embeddings')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Should throw QvacErrorRAG')
    if (err instanceof QvacErrorRAG) {
      t.is(err.code, ERR_CODES.INVALID_INPUT, 'Should have INVALID_INPUT error code')
    }
  }
})
