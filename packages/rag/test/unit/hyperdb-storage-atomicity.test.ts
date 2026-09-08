import test from 'brittle'
import tmp from 'test-tmp'
import Corestore from 'corestore'
import { HyperDBAdapter } from '../../src/adapters/database/HyperDBAdapter.js'
import type { HyperDBInstance, HyperDBTransaction } from '../../src/adapters/database/db-types.js'
import type { DocumentRecord, VectorRecord } from '../../src/adapters/database/HyperDBStorage.js'

function injectVectorInsertFailure(database: HyperDBInstance, targetId: string) {
  const exclusiveTransaction = database.exclusiveTransaction.bind(database)
  database.exclusiveTransaction = async function () {
    const transaction = await exclusiveTransaction()
    const insert = transaction.insert.bind(transaction)
    transaction.insert = async function (collection: string, record: object) {
      const vectorRecord = record as { docId?: string }
      if (collection === '@rag/vectors' && vectorRecord.docId === targetId) {
        throw new Error(`Injected vector failure for ${targetId}`)
      }
      await insert(collection, record)
    }
    return transaction as HyperDBTransaction
  }
}

test('HyperDBStorage preserves durable rows when an existing-ID vector write fails', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(tmpDir)
  const adapter = new HyperDBAdapter({
    store,
    dbName: 'test-existing-id-partial-failure'
  })
  await adapter.ready()

  await adapter.saveEmbeddings([
    {
      id: 'existing-id',
      content: 'Durable original content',
      embeddingModelId: 'test-model',
      embedding: [1, 0]
    }
  ])

  injectVectorInsertFailure(adapter.db!, 'existing-id')
  const results = await adapter.saveEmbeddings([
    {
      id: 'existing-id',
      content: 'Uncommitted replacement content',
      embeddingModelId: 'test-model',
      embedding: [0, 1]
    },
    {
      id: 'successful-id',
      content: 'Successful document',
      embeddingModelId: 'test-model',
      embedding: [0.5, 0.5]
    }
  ])

  t.is(
    results.find((result) => result.id === 'existing-id')?.status,
    'rejected',
    'The failed update should be rejected'
  )
  t.is(
    results.find((result) => result.id === 'successful-id')?.status,
    'fulfilled',
    'The independent document should be committed'
  )

  const snapshot = adapter.db!.snapshot()
  const existingDocument = await snapshot.get<DocumentRecord>('@rag/documents', {
    id: 'existing-id'
  })
  const existingVector = await snapshot.get<VectorRecord>('@rag/vectors', {
    docId: 'existing-id'
  })
  const successfulDocument = await snapshot.get<DocumentRecord>('@rag/documents', {
    id: 'successful-id'
  })
  const workspaceState = await snapshot.get<{ revision: number }>('@rag/workspaceState', {
    key: 'workspace'
  })
  const mutations = await snapshot
    .find<{ revision: number; documentIds: string[] }>('@rag/mutations')
    .toArray()
  await snapshot.close()

  t.is(existingDocument?.content, 'Durable original content', 'The durable document is preserved')
  t.alike(existingVector?.vector, [1, 0], 'The durable vector is preserved')
  t.ok(successfulDocument, 'The successful document is committed')
  t.is(workspaceState?.revision, 2, 'Only committed save transactions advance the workspace')
  t.alike(
    mutations.map((mutation) => [mutation.revision, mutation.documentIds]),
    [
      [1, ['existing-id']],
      [2, ['successful-id']]
    ],
    'Mutation rows describe only the document and vector rows committed with them'
  )

  await adapter.close()
  await store.close()
})

test('HyperDBStorage leaves no orphan rows when a new-ID vector write fails', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(tmpDir)
  const adapter = new HyperDBAdapter({
    store,
    dbName: 'test-new-id-partial-failure'
  })
  await adapter.ready()

  await adapter.saveEmbeddings([
    {
      id: 'seed-id',
      content: 'Seed document',
      embeddingModelId: 'test-model',
      embedding: [1, 0]
    }
  ])

  injectVectorInsertFailure(adapter.db!, 'partial-new-id')
  const results = await adapter.saveEmbeddings([
    {
      id: 'partial-new-id',
      content: 'Partially staged document',
      embeddingModelId: 'test-model',
      embedding: [0, 1]
    },
    {
      id: 'successful-new-id',
      content: 'Successful new document',
      embeddingModelId: 'test-model',
      embedding: [0.5, 0.5]
    }
  ])

  t.is(
    results.find((result) => result.id === 'partial-new-id')?.status,
    'rejected',
    'The partial write should be rejected'
  )
  t.is(
    results.find((result) => result.id === 'successful-new-id')?.status,
    'fulfilled',
    'The independent document should be committed'
  )

  const snapshot = adapter.db!.snapshot()
  const partialDocument = await snapshot.get<DocumentRecord>('@rag/documents', {
    id: 'partial-new-id'
  })
  const partialVector = await snapshot.get<VectorRecord>('@rag/vectors', {
    docId: 'partial-new-id'
  })
  const successfulDocument = await snapshot.get<DocumentRecord>('@rag/documents', {
    id: 'successful-new-id'
  })
  const successfulVector = await snapshot.get<VectorRecord>('@rag/vectors', {
    docId: 'successful-new-id'
  })
  await snapshot.close()

  t.is(partialDocument, null, 'The unflushed document row is discarded')
  t.is(partialVector, null, 'No vector row is committed')
  t.ok(successfulDocument, 'The successful document is committed')
  t.ok(successfulVector, 'The successful vector is committed')

  await adapter.close()
  await store.close()
})
