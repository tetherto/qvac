'use strict'

const test = require('brittle')
const { RAG, HyperDBAdapter, QvacLlmAdapter } = require('../../index')
const { QvacErrorRAG, ERR_CODES } = require('../../src/errors')
const QvacLogger = require('@qvac/logging')

const LlmPlugin = require('@qvac/llm-llamacpp')
const EmbedderPlugin = require('@qvac/embed-llamacpp')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const Corestore = require('corestore')
const HyperDB = require('hyperdb')

const fs = require('bare-fs')
const path = require('bare-path')

const llamaDriveKey = 'afa79ee07c0a138bb9f11bfaee771fb1bdfca8c82d961cff0474e49827bd1de3'
const gteDriveKey = 'd1896d9259692818df95bd2480e90c2d057688a4f7c9b1ae13ac7f5ee379d03e'

const store = new Corestore('./store')

const modelDir = './models'
const modelName = 'gte-large_fp16.gguf'

// Global test state to share resources across tests
let llamaHdDL, gteHdDL, llm, embedder, embeddingFunction, llmAdapter, dbAdapter, rag
let setupComplete = false

// Helper function to ensure models are loaded
async function ensureSetup () {
  if (setupComplete) return

  console.log('Setting up RAG environment with HyperDriveDL...')

  // Load embedder
  gteHdDL = new HyperDriveDL({
    key: `hd://${gteDriveKey}`,
    store
  })

  const embedderArgs = {
    loader: gteHdDL,
    opts: { stats: true },
    logger: console,
    diskPath: modelDir,
    modelName
  }
  embedder = new EmbedderPlugin(embedderArgs, '-ngl\t99\n-dev\tgpu\n--embd-separator\t⟪§§§EMBED_SEP§§§⟫\n-c\t4096')
  await embedder.load(false)

  embeddingFunction = async (text) => {
    const response = await embedder.run(text)
    const embeddings = await response.await()

    if (Array.isArray(text)) {
      // Batch: return array of arrays
      return embeddings[0].map(embedding => Array.from(embedding))
    } else {
      // Single: return single array
      return Array.from(embeddings[0][0])
    }
  }

  // Load LLM
  llamaHdDL = new HyperDriveDL({
    key: `hd://${llamaDriveKey}`,
    store
  })

  const llmArgs = {
    loader: llamaHdDL,
    opts: { stats: true },
    logger: console,
    diskPath: modelDir,
    modelName: 'Llama-3.2-1B-Instruct-Q4_0.gguf'
  }
  llm = new LlmPlugin(llmArgs, { ctx_size: '2048', gpu_layers: '99', device: 'gpu' })
  await llm.load(false)
  llmAdapter = new QvacLlmAdapter(llm)

  dbAdapter = new HyperDBAdapter({ store })

  // Create logger for visibility
  const logger = new QvacLogger(console)

  rag = new RAG({ embeddingFunction, dbAdapter, llm: llmAdapter, logger })
  await rag.ready()
  setupComplete = true
  console.log('RAG environment ready')
}

// Helper function to clean up
async function cleanup () {
  if (!setupComplete) return

  console.log('Cleaning up RAG environment...')
  if (rag) await rag.close()
  if (llamaHdDL) await llamaHdDL.close()
  if (gteHdDL) await gteHdDL.close()
  if (store) await store.close()
  setupComplete = false
  console.log('RAG environment cleaned up')
}

test('RAG Integration: Constructor validation', { timeout: 360000 }, async t => {
  await ensureSetup()
  t.comment('Testing RAG constructor')

  // Should work with all valid dependencies
  const validRag = new RAG({ embeddingFunction, dbAdapter, llm: llmAdapter })
  t.ok(validRag, 'RAG instance created with valid dependencies')

  // Should allow construction without LLM (LLM is only required for inference)
  const ragWithoutLLM = new RAG({ embeddingFunction, dbAdapter })
  t.ok(ragWithoutLLM, 'Should allow construction without LLM')

  // But inference should throw without LLM
  try {
    await ragWithoutLLM.infer('test query')
    t.fail('Should throw when trying to infer without LLM')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.LLM_REQUIRED, 'Should throw LLM_REQUIRED error for inference')
  }

  try {
    // eslint-disable-next-line no-new
    new RAG({ embeddingFunction, llm: llmAdapter })
    t.fail('Should throw when dbAdapter is missing')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.DB_ADAPTER_REQUIRED, 'Should throw DB_ADAPTER_REQUIRED error')
  }

  try {
    // eslint-disable-next-line no-new
    new RAG({ dbAdapter, llm: llmAdapter })
    t.fail('Should throw when embeddingFunction is missing')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.EMBEDDING_FUNCTION_REQUIRED, 'Should throw EMBEDDING_FUNCTION_REQUIRED error')
  }
})

test('RAG Integration: Document ingestion and processing', { timeout: 60000 }, async t => {
  await ensureSetup()
  t.comment('Testing document ingestion with chunking and embedding generation')

  // Test ingest with chunking (default behavior)
  const testDocs = [
    'This is a test document about Darwin\'s observations on species variation.',
    'Another document discussing the theory of natural selection and evolution.',
    'A third document about domestic breeding and artificial selection.'
  ]

  const result = await rag.ingest(testDocs, modelName)

  t.ok(result.processed, 'Should return processed results')
  t.ok(Array.isArray(result.processed), 'Processed results should be an array')
  t.ok(result.processed.length === 3, 'Should process all documents')
  t.ok(Array.isArray(result.droppedIndices), 'Should return dropped indices array')
  t.ok(result.droppedIndices.length === 0, 'Should have no dropped documents')

  // Verify all chunks have proper structure
  result.processed.forEach((doc, index) => {
    t.ok(doc.id, `Chunk ${index} should have an ID`)
    t.is(doc.status, 'fulfilled', `Chunk ${index} should have fulfilled status`)
  })

  // Test ingest without chunking - preserves existing IDs
  const simpleDoc = [{ id: 'no-chunk', content: 'Simple document without chunking' }]
  const noChunkResult = await rag.ingest(simpleDoc, modelName, { chunk: false })

  t.is(noChunkResult.processed.length, 1, 'Should process exactly one document without chunking')
  t.is(noChunkResult.processed[0].id, 'no-chunk', 'Should preserve document ID')
  t.is(noChunkResult.droppedIndices.length, 0, 'Should have no dropped documents')

  // Test mixed valid/invalid documents
  const mixedDocs = [
    'Valid document content',
    null, // Invalid
    { content: 'Valid document with content' },
    123, // Invalid
    '', // Invalid
    { id: 'valid-id', content: 'Valid document with ID' }
  ]

  const mixedResult = await rag.ingest(mixedDocs, modelName, { chunk: false })
  t.is(mixedResult.processed.length, 3, 'Should process only valid documents')
  t.is(mixedResult.droppedIndices.length, 3, 'Should drop invalid documents')
  t.alike(mixedResult.droppedIndices, [1, 3, 4], 'Should track correct dropped indices')
})

test('RAG Integration: Embedding generation and retrieval', { timeout: 30000 }, async t => {
  await ensureSetup()
  t.comment('Testing embedding generation for single text and multiple documents')

  // Test single text embedding
  const singleText = 'Generate embeddings for this text'
  const singleEmbedding = await rag.generateEmbeddings(singleText)

  t.ok(Array.isArray(singleEmbedding), 'Single embedding should be an array')
  t.ok(singleEmbedding.length > 0, 'Embedding should have dimensions')
  t.ok(singleEmbedding.every(val => typeof val === 'number'), 'All embedding values should be numbers')

  // Test multiple document embeddings
  const multiDocs = [
    'First document for embedding generation',
    'Second document with different content',
    'Third document to test batch processing'
  ]

  const multiEmbeddings = await rag.generateEmbeddingsForDocs(multiDocs)

  t.ok(typeof multiEmbeddings === 'object', 'Multi-doc embeddings should return an object')
  t.is(Object.keys(multiEmbeddings).length, 3, 'Should generate embeddings for all documents')

  Object.values(multiEmbeddings).forEach(embedding => {
    t.ok(Array.isArray(embedding), 'Each embedding should be an array')
    t.ok(embedding.length > 0, 'Each embedding should have dimensions')
    t.ok(embedding.every(val => typeof val === 'number'), 'All embedding values should be numbers')
  })
})

test('RAG Integration: Search and retrieval functionality', { timeout: 30000 }, async t => {
  await ensureSetup()
  t.comment('Testing document search and retrieval with real embeddings')

  // First, add some searchable documents from Darwin's topics
  const searchableDocs = [
    'Darwin observed great variation in domestic animals under human breeding.',
    'Natural selection acts on individual differences to preserve favorable traits.',
    'Domestic pigeons show remarkable diversity despite common ancestry.',
    'Artificial selection by breeders demonstrates the power of accumulative change.',
    'Species in nature struggle for existence due to limited resources.'
  ]

  await rag.ingest(searchableDocs, modelName, { chunk: false })

  // Test search functionality
  const searchQuery = 'How does breeding change domestic animals?'
  const searchResults = await rag.search(searchQuery, { topK: 3 })

  t.ok(Array.isArray(searchResults), 'Search results should be an array')
  t.ok(searchResults.length > 0, 'Should return search results')
  t.ok(searchResults.length <= 3, 'Should respect topK parameter')

  // Verify search result structure
  searchResults.forEach((result, index) => {
    t.ok(result.id, `Result ${index} should have an ID`)
    t.ok(result.content, `Result ${index} should have content`)
    t.ok(typeof result.score === 'number', `Result ${index} should have numeric score`)
    t.ok(result.score >= 0 && result.score <= 1, `Result ${index} score should be between 0 and 1`)
  })

  // Results should be sorted by relevance (highest score first)
  for (let i = 1; i < searchResults.length; i++) {
    t.ok(searchResults[i - 1].score >= searchResults[i].score, 'Results should be sorted by score descending')
  }
})

test('RAG Integration: Inference with context retrieval', { timeout: 60000 }, async t => {
  await ensureSetup()
  t.comment('Testing end-to-end inference with context retrieval')

  // Add knowledge base for inference
  const knowledgeDocs = [
    'Climate change is caused by increased greenhouse gas emissions from human activities.',
    'Renewable energy sources like solar and wind power help reduce carbon emissions.',
    'Electric vehicles are becoming more popular as battery technology improves.',
    'Sustainable agriculture practices can help preserve soil and water resources.'
  ]

  await rag.ingest(knowledgeDocs, modelName, { chunk: false })

  // Test inference with context
  const query = 'What causes climate change and how can we address it?'
  const response = await rag.infer(query, { topK: 2 })

  // For QVAC models, the response should be a stream
  if (response && typeof response.onUpdate === 'function') {
    const responseContent = []
    await response
      .onUpdate(update => {
        responseContent.push(update)
      })
      .await()

    t.ok(responseContent.length > 0, 'Should generate response content')
    const fullResponse = responseContent.join('')
    t.ok(fullResponse.length > 0, 'Should have non-empty response')
    console.log('Generated response:', fullResponse.substring(0, 200) + '...')
  } else {
    // Handle non-streaming response format
    t.ok(response, 'Should return a response')
    console.log('Response format:', typeof response)
  }

  // Test inference with no context (should handle gracefully)
  const noContextQuery = 'What is the capital of a fictional planet Zorbax?'
  const noContextResponse = await rag.infer(noContextQuery, { topK: 5 })

  // Should either return null/empty or a response indicating no context
  if (noContextResponse === null) {
    t.pass('Correctly returns null when no context found')
  } else {
    t.ok(noContextResponse, 'Should handle no-context scenario gracefully')
  }
})

test('RAG Integration: Document deletion and cleanup', { timeout: 30000 }, async t => {
  await ensureSetup()
  t.comment('Testing document deletion functionality')

  // Add documents to delete
  const docsToDelete = [
    { id: 'delete-1', content: 'Document to be deleted 1' },
    { id: 'delete-2', content: 'Document to be deleted 2' },
    { id: 'delete-3', content: 'Document to be deleted 3' }
  ]

  const saveResult = await rag.ingest(docsToDelete, modelName, { chunk: false })
  t.is(saveResult.processed.length, 3, 'Should save all documents for deletion test')

  // Test individual document deletion
  const deleteResult1 = await rag.deleteEmbeddings(['delete-1'])
  t.ok(deleteResult1, 'Should successfully delete single document')

  // Test multiple document deletion
  const deleteResult2 = await rag.deleteEmbeddings(['delete-2', 'delete-3'])
  t.ok(deleteResult2, 'Should successfully delete multiple documents')

  // Test deletion of non-existent documents (should not throw)
  const deleteResult3 = await rag.deleteEmbeddings(['non-existent-id'])
  t.ok(deleteResult3, 'Should handle deletion of non-existent documents gracefully')

  // Test invalid input to deleteEmbeddings
  const invalidInputs = [null, undefined, 'not-array', 123, {}]

  for (const invalidInput of invalidInputs) {
    try {
      await rag.deleteEmbeddings(invalidInput)
      t.fail(`Should throw error for invalid input: ${invalidInput}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      t.is(err.code, ERR_CODES.INVALID_PARAMS, 'Should throw INVALID_PARAMS error')
    }
  }
})

test('RAG Integration: Error handling and edge cases', { timeout: 30000 }, async t => {
  await ensureSetup()
  t.comment('Testing error handling across RAG operations')

  // Test duplicate document IDs
  const duplicateDocs = [
    { id: 'duplicate', content: 'First document' },
    { id: 'duplicate', content: 'Second document with same ID' }
  ]

  try {
    await rag.ingest(duplicateDocs, modelName, { chunk: false })
    t.fail('Should throw error for duplicate document IDs')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.DUPLICATE_DOCUMENT_ID, 'Should throw DUPLICATE_DOCUMENT_ID error')
  }

  // Test empty content handling
  const emptyContentDocs = [
    '', // dropped: falsy content
    '   ', // dropped: whitespace-only content (trimmed to empty)
    { content: '' }, // dropped: falsy content
    { id: 'empty', content: '   ' } // dropped: whitespace-only content (trimmed to empty)
  ]

  const emptyResult = await rag.ingest(emptyContentDocs, modelName, { chunk: false })
  t.is(emptyResult.processed.length, 0, 'Should drop all empty and whitespace-only content documents')
  t.is(emptyResult.droppedIndices.length, 4, 'Should track all dropped documents')

  // Test very large content handling
  const largeContent = 'Large document content. '.repeat(100)
  const largeDoc = [{ id: 'large-doc', content: largeContent }]

  const largeResult = await rag.ingest(largeDoc, modelName, { chunk: false })
  t.is(largeResult.processed.length, 1, 'Should handle large documents')
  t.is(largeResult.processed[0].status, 'fulfilled', 'Should successfully process large document')
})

test('RAG Integration: Chunking behavior and options', { timeout: 30000 }, async t => {
  await ensureSetup()
  t.comment('Testing different chunking strategies and options')

  const longDocument = `
    This is a very long document that should be split into multiple chunks when processed.
    The chunking service should break this down into manageable pieces based on the configured options.
    Each chunk should maintain semantic meaning while respecting the size constraints.
    The embedding service will then generate embeddings for each chunk separately.
    Finally, the database adapter will store all chunks with their associated embeddings.
    This allows for more granular retrieval and better context matching during inference.
  `.trim()

  // Test with chunking enabled (using smaller chunk size to ensure chunking)
  const chunkedResult = await rag.ingest(longDocument, modelName, {
    chunkOpts: {
      chunkSize: 15, // Small chunk size to ensure multiple chunks
      chunkOverlap: 3
    }
  })
  t.ok(chunkedResult.processed.length > 1, 'Should create multiple chunks from long document')

  // Test with chunking disabled
  const unchunkedResult = await rag.ingest(longDocument, modelName, { chunk: false })
  t.is(unchunkedResult.processed.length, 1, 'Should create single document when chunking disabled')

  // Test custom chunk options
  const customChunkResult = await rag.ingest(longDocument, modelName, {
    chunkOpts: {
      chunkSize: 10,
      chunkOverlap: 2
    }
  })
  t.ok(customChunkResult.processed.length >= chunkedResult.processed.length,
    'Smaller chunk size should create more chunks')

  // All chunks should have valid structure
  customChunkResult.processed.forEach(chunk => {
    t.ok(chunk.id, 'Each chunk should have an ID')
    t.is(chunk.status, 'fulfilled', 'Each chunk should have fulfilled status')
  })
})

test('RAG Integration: Full workflow with sample text file', { timeout: 500000 }, async t => {
  await ensureSetup()
  t.comment('Testing complete RAG workflow with sample text file, this may take a while...')

  // Load sample text file
  const samplePath = path.join(__dirname, 'sample.txt')
  const sampleText = fs.readFileSync(samplePath, 'utf8')

  // Track progress for verification
  const progressCalls = []

  // Process the complete workflow
  t.comment('Step 1: Save embeddings with chunking')
  const saveResult = await rag.ingest(sampleText, modelName, {
    progressInterval: 5,
    onProgress: (stage, current, total) => {
      progressCalls.push({ stage, current, total })
    }
  })
  t.ok(saveResult.processed.length > 0, 'Should process sample text into chunks')

  // Verify progress reporting worked
  const stages = [...new Set(progressCalls.map(p => p.stage))]
  t.comment(`Progress stages received: ${stages.join(', ')}`)
  t.ok(stages.includes('chunking'), 'Should report chunking stage')
  t.ok(stages.includes('embedding'), 'Should report embedding stage')
  t.ok(stages.some(s => s.startsWith('saving:')), 'Should report saving sub-stages')

  const processedIds = saveResult.processed.map(doc => doc.id)
  t.comment(`Created ${processedIds.length} chunks from sample text`)

  t.comment('Step 2: Search for relevant context')
  const searchQuery = 'What did Darwin say about variation in domestic animals?'
  const searchResults = await rag.search(searchQuery, { topK: 3 })
  console.log('searchResults:', searchResults)
  t.ok(searchResults.length > 0, 'Should find relevant context for Darwin variation query')

  t.comment('Step 3: Generate inference response')
  const inferenceQuery = 'How does natural selection work?'
  const response = await rag.infer(inferenceQuery, { topK: 1 })

  if (response && typeof response.onUpdate === 'function') {
    const responseOutputs = []
    await response
      .onUpdate(update => {
        responseOutputs.push(update)
      })
      .await()

    t.ok(responseOutputs.length > 0, 'Should generate inference response')
    const fullResponse = responseOutputs.join('')
    t.comment(`Generated response length: ${fullResponse.length} characters`)
    console.log('Sample response preview:', fullResponse.substring(0, 300) + '...')
  }

  t.comment('Step 4: Reindex database...')
  const preReindexSearch = await rag.search('natural selection', { topK: 3 })
  console.log('preReindexSearch:', preReindexSearch)
  const reindexProgressCalls = []
  const reindexResult = await rag.reindex({
    onProgress: (stage, current, total) => {
      reindexProgressCalls.push({ stage, current, total })
    }
  })

  t.comment(`Reindex result: reindexed=${reindexResult.reindexed}, details=${JSON.stringify(reindexResult.details)}`)
  t.ok(reindexResult.reindexed, 'Should reindex database')
  t.ok(reindexResult.details?.documentCount >= 100, 'Should have significant document count')

  const reindexStages = [...new Set(reindexProgressCalls.map(p => p.stage))]
  t.comment(`Reindex stages: ${reindexStages.join(', ')}`)
  t.ok(reindexStages.includes('collecting'), 'Should report collecting stage')
  t.ok(reindexStages.includes('reassigning'), 'Should report reassigning stage')

  t.comment('Step 5: Verify search works after reindexing')
  const postReindexSearch = await rag.search('natural selection', { topK: 3 })
  console.log('postReindexSearch:', postReindexSearch)
  t.ok(postReindexSearch.length > 0, 'Search should work after reindexing')

  t.comment('Step 6: Clean up created documents')
  const deleteResult = await rag.deleteEmbeddings(processedIds)
  t.ok(deleteResult, 'Should successfully delete all created chunks')

  t.comment('Full workflow completed successfully')
})

test('RAG Integration: External HyperDB instance with default spec', { timeout: 360000 }, async t => {
  await ensureSetup()
  t.comment('Testing HyperDBAdapter with externally provided HyperDB instance')

  // Create a separate store for this test
  const testStore = new Corestore('./test-external-hyperdb-store')
  let externalHypercore = null
  let externalHyperDB = null
  let externalAdapter = null
  let testRag = null

  try {
    t.comment('Step 1: Create external HyperDB instance with default spec')
    externalHypercore = testStore.get({ name: 'external-rag-test' })
    const dbSpecModule = await import('../../src/adapters/database/hyperspec/hyperdb/index.js')
    const dbSpec = await (dbSpecModule.default || dbSpecModule)
    externalHyperDB = HyperDB.bee(externalHypercore, dbSpec, { autoUpdate: true })
    await externalHyperDB.ready()
    t.pass('External HyperDB instance created successfully')

    t.comment('Step 2: Create HyperDBAdapter with external HyperDB (using default table names for compatibility)')
    externalAdapter = new HyperDBAdapter({
      db: externalHyperDB,
      NUM_CENTROIDS: 8,
      BATCH_SIZE: 50,
      CACHE_SIZE: 500
      // Note: Using default table names since they match the default HyperDB spec
      // Custom table names would require a matching custom HyperDB spec
    })

    t.comment('Step 3: Create RAG instance with external adapter')
    testRag = new RAG({
      embeddingFunction,
      dbAdapter: externalAdapter,
      llm: llmAdapter
    })
    await testRag.ready()
    t.pass('RAG instance initialized with external HyperDB adapter')

    t.comment('Step 4: Verify hypercore and table names are properly set')
    t.ok(externalAdapter.core, 'Adapter should have hypercore reference')
    t.ok(externalAdapter.core === externalHypercore, 'Adapter hypercore should match external hypercore')

    // Verify default table names are set correctly
    t.ok(externalAdapter.documentsTable === '@rag/documents', 'Documents table name should be default')
    t.ok(externalAdapter.vectorsTable === '@rag/vectors', 'Vectors table name should be default')
    t.ok(externalAdapter.centroidsTable === '@rag/centroids', 'Centroids table name should be default')
    t.ok(externalAdapter.invertedIndexTable === '@rag/ivfBuckets', 'Inverted index table name should be default')
    t.comment('Table names configuration feature is available for use with custom HyperDB specs')

    t.comment('Step 5: Test basic RAG operations')
    const testDocs = [
      'External HyperDB test document about quantum physics and string theory.',
      'Another test document discussing machine learning and neural networks.',
      'Final test document covering database indexing and vector search.'
    ]

    // Generate and save embeddings
    const saveResults = await testRag.ingest(testDocs, modelName)
    t.ok(saveResults.processed.length === 3, 'Should process all test documents')
    t.ok(saveResults.processed.every(r => r.status === 'fulfilled'), 'All documents should be processed successfully')

    const docIds = saveResults.processed.map(r => r.id)
    t.comment(`Created documents with IDs: ${docIds.join(', ')}`)

    // Test search functionality
    const searchResults = await testRag.search('quantum physics', { topK: 2 })
    t.ok(searchResults.length > 0, 'Should find relevant documents')
    t.ok(searchResults[0].score > 0, 'Results should have positive similarity scores')
    t.comment(`Found ${searchResults.length} results, top score: ${searchResults[0].score.toFixed(3)}`)

    // Test inference if LLM is available
    if (llmAdapter) {
      const response = await testRag.infer('What is quantum physics?', { topK: 1 })
      t.ok(response, 'Should generate inference response')
      t.comment('Inference completed successfully with external HyperDB')
    }

    // Clean up test data
    const deleteResult = await testRag.deleteEmbeddings(docIds)
    t.ok(deleteResult, 'Should successfully delete test documents')

    t.comment('Step 6: Verify adapter state after operations')
    t.ok(externalAdapter.isInitialized, 'Adapter should remain initialized')
    t.ok(externalAdapter.centroids.length > 0, 'Centroids should be properly initialized')

    t.pass('External HyperDB integration test completed successfully')
  } catch (error) {
    t.fail(`External HyperDB test failed: ${error.message}`)
  } finally {
    // Clean up resources
    if (testRag) {
      try {
        await testRag.close()
        t.comment('Test RAG instance closed')
      } catch (closeError) {
        t.comment(`RAG close error (non-critical): ${closeError.message}`)
      }
    }
    if (testStore) {
      try {
        await testStore.close()
        t.comment('Test store closed')
      } catch (storeError) {
        t.comment(`Store close error (non-critical): ${storeError.message}`)
      }
    }
  }
})

test('RAG Integration: Cleanup test environment', { timeout: 30000 }, async t => {
  t.comment('Cleaning up QVAC environment after all tests')
  await cleanup()
  t.pass('Environment cleanup completed')
})
