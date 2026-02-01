'use strict'

const test = require('brittle')
const EmbeddingService = require('../../src/services/core/EmbeddingService')
const { QvacErrorRAG, ERR_CODES } = require('../../src/errors')

class MockEmbeddingFunction {
  constructor () {
    this.calls = []
    this.shouldFail = false
  }

  async call (text) {
    this.calls.push(text)
    if (this.shouldFail) {
      throw new Error('Mock embedding function failure')
    }

    // Support both single and batch
    if (Array.isArray(text)) {
      return text.map(() => [0.1, 0.2, 0.3])
    }
    return [0.1, 0.2, 0.3]
  }

  reset () {
    this.calls = []
    this.shouldFail = false
  }
}

// Create a callable function that delegates to the mock
function createMockEmbeddingFunction () {
  const mock = new MockEmbeddingFunction()
  const func = async (text) => {
    return await mock.call(text)
  }
  func.mock = mock
  return func
}

test('EmbeddingService: should create with valid embedding function', t => {
  const mockEmbeddingFunction = createMockEmbeddingFunction()
  const service = new EmbeddingService({ embeddingFunction: mockEmbeddingFunction })
  t.is(service.embeddingFunction, mockEmbeddingFunction, 'Should store the embedding function instance')
})

test('EmbeddingService: should throw error when embedding function not provided', t => {
  const invalidEmbeddingFunctions = [null, undefined, {}]

  invalidEmbeddingFunctions.forEach(embeddingFunction => {
    try {
      // eslint-disable-next-line no-new
      new EmbeddingService({ embeddingFunction })
      t.fail(`Should throw error for invalid embedding function: ${embeddingFunction}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      t.is(err.code, ERR_CODES.EMBEDDING_FUNCTION_REQUIRED, 'Error code should be EMBEDDING_FUNCTION_REQUIRED')
    }
  })
})

test('EmbeddingService: should generate embeddings for valid text', async t => {
  const mockEmbeddingFunction = createMockEmbeddingFunction()
  const service = new EmbeddingService({ embeddingFunction: mockEmbeddingFunction })

  const result = await service.generateEmbeddings('test text')

  t.is(mockEmbeddingFunction.mock.calls.length, 1, 'Should call embedding function once')
  t.is(mockEmbeddingFunction.mock.calls[0], 'test text', 'Should pass text to embedding function')
  t.ok(Array.isArray(result), 'Should return an array')
  t.ok(result.length > 0, 'Should return non-empty embeddings')
})

test('EmbeddingService: should handle empty or invalid text input', async t => {
  const mockEmbeddingFunction = createMockEmbeddingFunction()
  const service = new EmbeddingService({ embeddingFunction: mockEmbeddingFunction })

  const invalidInputs = ['', '   ', null, undefined, 123]

  for (const input of invalidInputs) {
    try {
      await service.generateEmbeddings(input)
      t.fail(`Should throw error for invalid input: ${input}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
      t.ok(err.message.includes('Invalid input') || err.message.includes('invalid'), 'Error message should mention invalid input')
    }
  }
})

test('EmbeddingService: should handle embedding function failure', async t => {
  const mockEmbeddingFunction = createMockEmbeddingFunction()
  mockEmbeddingFunction.mock.shouldFail = true
  const service = new EmbeddingService({ embeddingFunction: mockEmbeddingFunction })

  try {
    await service.generateEmbeddings('test text')
    t.fail('Should throw error when embedding function fails')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.GENERATION_FAILED, 'Error code should be GENERATION_FAILED')
    t.ok(err.message.includes('Failed to generate embeddings'), 'Error message should be descriptive')
  }
})

test('EmbeddingService: should generate embeddings for multiple documents', async t => {
  const mockEmbeddingFunction = createMockEmbeddingFunction()
  const service = new EmbeddingService({ embeddingFunction: mockEmbeddingFunction })

  const docs = [
    { id: 'doc1', content: 'First document' },
    { id: 'doc2', content: 'Second document' },
    { id: 'doc3', content: 'Third document' }
  ]

  const result = await service.generateEmbeddingsForDocs(docs)

  t.is(mockEmbeddingFunction.mock.calls.length, 1, 'Should call embedding function once for batch')
  t.ok(Array.isArray(mockEmbeddingFunction.mock.calls[0]), 'Should pass array of texts')
  t.is(mockEmbeddingFunction.mock.calls[0].length, 3, 'Should pass all document contents')
  t.is(mockEmbeddingFunction.mock.calls[0][0], 'First document', 'First text in batch')
  t.is(mockEmbeddingFunction.mock.calls[0][1], 'Second document', 'Second text in batch')
  t.is(mockEmbeddingFunction.mock.calls[0][2], 'Third document', 'Third text in batch')

  t.ok(typeof result === 'object', 'Should return an object')
  t.ok(result.doc1, 'Should have embeddings for doc1')
  t.ok(result.doc2, 'Should have embeddings for doc2')
  t.ok(result.doc3, 'Should have embeddings for doc3')

  t.ok(Array.isArray(result.doc1), 'Doc1 embeddings should be an array')
  t.ok(Array.isArray(result.doc2), 'Doc2 embeddings should be an array')
  t.ok(Array.isArray(result.doc3), 'Doc3 embeddings should be an array')
})

test('EmbeddingService: should handle invalid documents array', async t => {
  const mockEmbeddingFunction = createMockEmbeddingFunction()
  const service = new EmbeddingService({ embeddingFunction: mockEmbeddingFunction })

  const invalidInputs = [null, undefined, 'not-array', 123, []]

  for (const input of invalidInputs) {
    try {
      await service.generateEmbeddingsForDocs(input)
      t.fail(`Should throw error for invalid docs input: ${input}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
    }
  }
})

test('EmbeddingService: should handle documents with missing id or content', async t => {
  const mockEmbeddingFunction = createMockEmbeddingFunction()
  const service = new EmbeddingService({ embeddingFunction: mockEmbeddingFunction })

  const invalidDocs = [
    [{ content: 'No ID' }],
    [{ id: 'no-content' }],
    [{ id: '', content: 'Empty ID' }],
    [{ id: 'valid', content: '' }],
    [{ id: null, content: 'Null ID' }]
  ]

  for (const docs of invalidDocs) {
    try {
      await service.generateEmbeddingsForDocs(docs)
      t.fail(`Should throw error for invalid docs: ${JSON.stringify(docs)}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
      t.ok(err.message, 'Should have error message')
    }
  }
})

test('EmbeddingService: should handle embedding function failure in batch processing', async t => {
  const mockEmbeddingFunction = createMockEmbeddingFunction()
  mockEmbeddingFunction.mock.shouldFail = true
  const service = new EmbeddingService({ embeddingFunction: mockEmbeddingFunction })

  const docs = [
    { id: 'doc1', content: 'First document' },
    { id: 'doc2', content: 'Second document' }
  ]

  try {
    await service.generateEmbeddingsForDocs(docs)
    t.fail('Should throw error when embedding function fails during batch processing')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.GENERATION_FAILED, 'Error code should be GENERATION_FAILED')
    t.ok(err.message.includes('Failed to generate batch embeddings'), 'Error message should mention batch embeddings')
  }
})

test('EmbeddingService: should preserve document order in results', async t => {
  const mockEmbeddingFunction = createMockEmbeddingFunction()
  const service = new EmbeddingService({ embeddingFunction: mockEmbeddingFunction })

  const docs = [
    { id: 'first', content: 'Document 1' },
    { id: 'second', content: 'Document 2' },
    { id: 'third', content: 'Document 3' }
  ]

  const result = await service.generateEmbeddingsForDocs(docs)

  // Check that all expected keys exist
  const resultKeys = Object.keys(result)
  t.is(resultKeys.length, 3, 'Should have embeddings for all documents')
  t.ok(resultKeys.includes('first'), 'Should have first document')
  t.ok(resultKeys.includes('second'), 'Should have second document')
  t.ok(resultKeys.includes('third'), 'Should have third document')

  t.is(mockEmbeddingFunction.mock.calls.length, 1, 'Should make one batch call')
  t.is(mockEmbeddingFunction.mock.calls[0][0], 'Document 1', 'Batch should contain first document')
  t.is(mockEmbeddingFunction.mock.calls[0][1], 'Document 2', 'Batch should contain second document')
  t.is(mockEmbeddingFunction.mock.calls[0][2], 'Document 3', 'Batch should contain third document')
})

test('EmbeddingService: should support cancellation via AbortSignal', async t => {
  const mockEmbeddingFunction = createMockEmbeddingFunction()
  const service = new EmbeddingService({ embeddingFunction: mockEmbeddingFunction })

  const docs = [
    { id: 'doc1', content: 'Document' }
  ]

  const abortController = { signal: { aborted: true } }

  try {
    await service.generateEmbeddingsForDocs(docs, abortController)
    t.fail('Should throw error when signal is aborted')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.OPERATION_CANCELLED, 'Error code should be OPERATION_CANCELLED')
  }
})

test('EmbeddingService: should call onProgress callback at start and end', async t => {
  const mockEmbeddingFunction = createMockEmbeddingFunction()
  const service = new EmbeddingService({ embeddingFunction: mockEmbeddingFunction })

  const docs = [
    { id: 'doc1', content: 'First' },
    { id: 'doc2', content: 'Second' }
  ]

  const progressCalls = []

  await service.generateEmbeddingsForDocs(docs, {
    onProgress: (current, total) => {
      progressCalls.push({ current, total })
    }
  })

  t.is(progressCalls.length, 2, 'Should call onProgress twice (start and end)')
  t.alike(progressCalls[0], { current: 0, total: 2 }, 'First call should be start')
  t.alike(progressCalls[1], { current: 2, total: 2 }, 'Second call should be completion')
})

test('EmbeddingService: should support generateEmbeddings with array input', async t => {
  const mockEmbeddingFunction = createMockEmbeddingFunction()
  const service = new EmbeddingService({ embeddingFunction: mockEmbeddingFunction })

  const texts = ['text1', 'text2', 'text3']
  const result = await service.generateEmbeddings(texts)

  t.ok(Array.isArray(result), 'Should return array')
  t.is(result.length, 3, 'Should return embeddings for all texts')
  t.ok(Array.isArray(result[0]), 'Each embedding should be an array')
  t.is(mockEmbeddingFunction.mock.calls.length, 1, 'Should make one batch call')
  t.alike(mockEmbeddingFunction.mock.calls[0], texts, 'Should pass array to embedding function')
})

test('EmbeddingService: Zod validation should reject invalid embedding outputs', async t => {
  const invalidOutputFunction = async (text) => {
    if (Array.isArray(text)) {
      return ['not', 'numbers'] // Invalid: strings instead of number arrays
    }
    return 'not an array' // Invalid: string instead of array
  }

  const service = new EmbeddingService({ embeddingFunction: invalidOutputFunction })

  // Test single text with invalid output
  try {
    await service.generateEmbeddings('test')
    t.fail('Should throw for invalid single embedding output')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Should throw QvacErrorRAG')
    t.is(err.code, ERR_CODES.GENERATION_FAILED, 'Should be GENERATION_FAILED for output validation')
    t.ok(err.message.includes('invalid output'), 'Error message should mention invalid output')
  }

  // Test batch with invalid output
  try {
    await service.generateEmbeddings(['test1', 'test2'])
    t.fail('Should throw for invalid batch embedding output')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Should throw QvacErrorRAG')
    t.is(err.code, ERR_CODES.GENERATION_FAILED, 'Should be GENERATION_FAILED for output validation')
    t.ok(err.message.includes('invalid output'), 'Error message should mention invalid output')
  }
})
