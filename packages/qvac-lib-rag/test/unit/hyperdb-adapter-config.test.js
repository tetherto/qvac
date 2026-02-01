'use strict'

const test = require('brittle')
const tmp = require('test-tmp')
const Corestore = require('corestore')
const HyperDBAdapter = require('../../src/adapters/database/HyperDBAdapter')
const { QvacErrorRAG, ERR_CODES } = require('../../src/errors')

test('HyperDBAdapter - Config persistence on first save', async t => {
  const tmpDir = await tmp()
  const store = new Corestore(tmpDir)
  const adapter = new HyperDBAdapter({
    store,
    dbName: 'test-config-db'
  })

  await adapter.ready()

  // Initially, no config should exist
  const configBefore = await adapter.getConfig()
  t.is(configBefore, null, 'Config should be null before first save')

  // Save embeddings with embeddingModelId
  const embeddedDocs = [
    {
      id: 'doc1',
      content: 'Test document 1',
      embeddingModelId: 'model-abc123',
      embedding: Array(384).fill(0.1)
    },
    {
      id: 'doc2',
      content: 'Test document 2',
      embeddingModelId: 'model-abc123',
      embedding: Array(384).fill(0.2)
    }
  ]

  await adapter.saveEmbeddings(embeddedDocs)

  // Config should now be persisted
  const configAfter = await adapter.getConfig()
  t.ok(configAfter, 'Config should exist after first save')
  t.is(configAfter.key, 'adapter', 'Config should have key')
  t.is(configAfter.embeddingModelId, 'model-abc123', 'Config should have correct embeddingModelId')
  t.is(configAfter.dimension, 384, 'Config should have correct dimension')
  t.is(configAfter.NUM_CENTROIDS, 16, 'Config should have NUM_CENTROIDS')
  t.is(configAfter.BUCKET_SIZE, 50, 'Config should have BUCKET_SIZE')
  t.is(configAfter.BATCH_SIZE, 100, 'Config should have BATCH_SIZE')
  t.ok(configAfter.createdAt instanceof Date, 'Config should have createdAt timestamp')

  await adapter.close()
})

test('HyperDBAdapter - Config validation with matching modelId and dimension', async t => {
  const tmpDir = await tmp()
  const store = new Corestore(tmpDir)

  // First adapter - persist config
  const adapter1 = new HyperDBAdapter({
    store,
    dbName: 'test-validation-db'
  })
  await adapter1.ready()

  const embeddedDocs1 = [
    {
      id: 'doc1',
      content: 'Test document',
      embeddingModelId: 'model-abc123',
      embedding: Array(384).fill(0.1)
    }
  ]
  await adapter1.saveEmbeddings(embeddedDocs1)

  const config1 = await adapter1.getConfig()
  t.ok(config1, 'Config should exist after save')
  t.is(config1.embeddingModelId, 'model-abc123', 'Config should have correct modelId')
  t.is(config1.dimension, 384, 'Config should have correct dimension')

  await adapter1.close()

  // Second adapter - should validate modelId and dimension match
  const adapter2 = new HyperDBAdapter({
    store,
    dbName: 'test-validation-db'
  })
  await adapter2.ready()

  const config2 = await adapter2.getConfig()
  t.ok(config2, 'Config should still exist in new adapter instance')
  t.is(config2.embeddingModelId, 'model-abc123', 'Config should have same modelId')
  t.is(config2.dimension, 384, 'Config should have same dimension')

  // Should allow saving with same modelId and dimension
  const embeddedDocs2 = [
    {
      id: 'doc2',
      content: 'Another document',
      embeddingModelId: 'model-abc123',
      embedding: Array(384).fill(0.2)
    }
  ]

  await adapter2.saveEmbeddings(embeddedDocs2)
  t.pass('Should allow saving with same embeddingModelId and dimension')

  await adapter2.close()
})

test('HyperDBAdapter - Config mismatch error with different modelId', async t => {
  const tmpDir = await tmp()
  const store = new Corestore(tmpDir)

  // First initialization - persist config
  const adapter1 = new HyperDBAdapter({
    store,
    dbName: 'test-mismatch-db'
  })
  await adapter1.ready()

  const embeddedDocs1 = [
    {
      id: 'doc1',
      content: 'Test document',
      embeddingModelId: 'model-abc123',
      embedding: Array(384).fill(0.1)
    }
  ]
  await adapter1.saveEmbeddings(embeddedDocs1)
  await adapter1.close()

  // Second initialization with different modelId - should throw
  const adapter2 = new HyperDBAdapter({
    store,
    dbName: 'test-mismatch-db'
  })
  await adapter2.ready()

  const embeddedDocs2 = [
    {
      id: 'doc2',
      content: 'Another document',
      embeddingModelId: 'model-different',
      embedding: Array(384).fill(0.2)
    }
  ]

  try {
    await adapter2.saveEmbeddings(embeddedDocs2)
    t.fail('Should have thrown EMBEDDING_MODEL_MISMATCH')
  } catch (error) {
    t.ok(error instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(error.code, ERR_CODES.EMBEDDING_MODEL_MISMATCH, 'Error code should be EMBEDDING_MODEL_MISMATCH')
    t.ok(error.message.includes('model-abc123'), 'Error message should mention stored model')
    t.ok(error.message.includes('model-different'), 'Error message should mention provided model')
  }

  await adapter2.close()
})

test('HyperDBAdapter - Error when embeddingModelId missing from documents', async t => {
  const tmpDir = await tmp()
  const store = new Corestore(tmpDir)
  const adapter = new HyperDBAdapter({
    store,
    dbName: 'test-missing-modelid-db'
  })

  await adapter.ready()

  const embeddedDocs = [
    {
      id: 'doc1',
      content: 'Test document',
      // Missing embeddingModelId
      embedding: Array(384).fill(0.1)
    }
  ]

  try {
    await adapter.saveEmbeddings(embeddedDocs)
    t.fail('Should have thrown INVALID_PARAMS for missing embeddingModelId')
  } catch (error) {
    t.ok(error instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(error.code, ERR_CODES.INVALID_PARAMS, 'Error code should be INVALID_PARAMS')
    t.ok(error.message.includes('embeddingModelId is required'), 'Error message should mention embeddingModelId is required')
  }

  await adapter.close()
})

test('HyperDBAdapter - Error when documents have different embeddingModelIds', async t => {
  const tmpDir = await tmp()
  const store = new Corestore(tmpDir)
  const adapter = new HyperDBAdapter({
    store,
    dbName: 'test-inconsistent-modelid-db'
  })

  await adapter.ready()

  const embeddedDocs = [
    {
      id: 'doc1',
      content: 'Test document 1',
      embeddingModelId: 'model-abc123',
      embedding: Array(384).fill(0.1)
    },
    {
      id: 'doc2',
      content: 'Test document 2',
      embeddingModelId: 'model-xyz789', // Different model!
      embedding: Array(384).fill(0.2)
    }
  ]

  try {
    await adapter.saveEmbeddings(embeddedDocs)
    t.fail('Should have thrown INVALID_PARAMS for inconsistent embeddingModelIds')
  } catch (error) {
    t.ok(error instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(error.code, ERR_CODES.INVALID_PARAMS, 'Error code should be INVALID_PARAMS')
    t.ok(error.message.includes('same embeddingModelId'), 'Error message should mention consistency requirement')
    t.ok(error.message.includes('model-abc123'), 'Error message should list found model IDs')
    t.ok(error.message.includes('model-xyz789'), 'Error message should list found model IDs')
  }

  await adapter.close()
})

test('HyperDBAdapter - getConfig returns null for unconfigured workspace', async t => {
  const tmpDir = await tmp()
  const store = new Corestore(tmpDir)
  const adapter = new HyperDBAdapter({
    store,
    dbName: 'test-unconfigured-db'
  })

  await adapter.ready()

  const config = await adapter.getConfig()
  t.is(config, null, 'Config should be null for unconfigured workspace')

  await adapter.close()
})

test('HyperDBAdapter - Config persists across adapter instances', async t => {
  const tmpDir = await tmp()
  const store = new Corestore(tmpDir)

  // First adapter - save embeddings
  const adapter1 = new HyperDBAdapter({
    store,
    dbName: 'test-persist-db'
  })
  await adapter1.ready()

  const embeddedDocs = [
    {
      id: 'doc1',
      content: 'Test document',
      embeddingModelId: 'model-persist-test',
      embedding: Array(384).fill(0.1)
    }
  ]
  await adapter1.saveEmbeddings(embeddedDocs)

  const config1 = await adapter1.getConfig()
  t.ok(config1, 'Config should exist after save')
  t.is(config1.embeddingModelId, 'model-persist-test', 'Config should have correct modelId')

  await adapter1.close()

  // Second adapter - should load same config
  const adapter2 = new HyperDBAdapter({
    store,
    dbName: 'test-persist-db'
  })
  await adapter2.ready()

  const config2 = await adapter2.getConfig()
  t.ok(config2, 'Config should still exist in new adapter instance')
  t.is(config2.embeddingModelId, 'model-persist-test', 'Config should have same modelId')
  t.alike(config1.createdAt, config2.createdAt, 'createdAt should be the same')

  await adapter2.close()
})

test('HyperDBAdapter - Config dimension mismatch error', async t => {
  const tmpDir = await tmp()
  const store = new Corestore(tmpDir)

  // First initialization - persist config with dimension 384
  const adapter1 = new HyperDBAdapter({
    store,
    dbName: 'test-dimension-mismatch-db'
  })
  await adapter1.ready()

  const embeddedDocs1 = [
    {
      id: 'doc1',
      content: 'Test document',
      embeddingModelId: 'model-abc123',
      embedding: Array(384).fill(0.1)
    }
  ]
  await adapter1.saveEmbeddings(embeddedDocs1)
  await adapter1.close()

  // Second initialization with different dimension - should throw
  const adapter2 = new HyperDBAdapter({
    store,
    dbName: 'test-dimension-mismatch-db'
  })
  await adapter2.ready()

  const embeddedDocs2 = [
    {
      id: 'doc2',
      content: 'Another document',
      embeddingModelId: 'model-abc123',
      embedding: Array(512).fill(0.2) // Different dimension!
    }
  ]

  try {
    await adapter2.saveEmbeddings(embeddedDocs2)
    t.fail('Should have thrown EMBEDDING_DIMENSION_MISMATCH')
  } catch (error) {
    t.ok(error instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(error.code, ERR_CODES.EMBEDDING_DIMENSION_MISMATCH, 'Error code should be EMBEDDING_DIMENSION_MISMATCH')
    t.ok(error.message.includes('384'), 'Error message should mention stored dimension')
    t.ok(error.message.includes('512'), 'Error message should mention provided dimension')
  }

  await adapter2.close()
})
