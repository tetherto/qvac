'use strict'

const test = require('brittle')
const ChunkingService = require('../../src/services/core/ChunkingService')
const LLMChunkAdapter = require('../../src/adapters/chunker/LLMChunkAdapter')
const { QvacErrorRAG, ERR_CODES } = require('../../src/errors')
const { tokenizeText } = require('../../src/adapters/chunker/Tokenizer')

test('ChunkingService: should create with default LLMChunkAdapter when no chunker provided', t => {
  const service = new ChunkingService({})

  t.ok(service.chunker instanceof LLMChunkAdapter, 'Should use LLMChunkAdapter as default')
  t.alike(service.chunkOpts, {}, 'Should have empty chunk options by default')
})

test('ChunkingService: should create with provided chunker', t => {
  const mockChunker = new LLMChunkAdapter({ splitStrategy: 'word' })
  const chunkOpts = { chunkSize: 512, chunkOverlap: 50 }

  const service = new ChunkingService({
    chunker: mockChunker,
    chunkOpts
  })

  t.is(service.chunker, mockChunker, 'Should use provided chunker')
  t.alike(service.chunkOpts, chunkOpts, 'Should store provided chunk options')
})

test('ChunkingService: should throw error for invalid chunker', t => {
  const invalidChunkers = [
    'not-a-chunker',
    { chunkText: () => { } },
    123,
    new Date()
  ]

  invalidChunkers.forEach(invalidChunker => {
    try {
      // eslint-disable-next-line no-new
      new ChunkingService({ chunker: invalidChunker })
      t.fail(`Should throw error for invalid chunker: ${invalidChunker}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      t.is(err.code, ERR_CODES.INVALID_CHUNKER, 'Error code should be INVALID_CHUNKER')
    }
  })
})

test('ChunkingService: should produce chunks with word splitStrategy', async t => {
  const service = new ChunkingService({
    chunker: new LLMChunkAdapter({ splitStrategy: 'word' }),
    chunkOpts: { chunkSize: 3, chunkOverlap: 1 }
  })

  const input = 'The quick brown fox jumps over lazy dog'
  const result = await service.chunkText(input)

  t.ok(Array.isArray(result), 'Result should be an array')
  t.is(result.length, 4, 'Should create exactly 4 chunks')
  t.is(result[0].content, 'The quick brown', 'First chunk should contain first 3 words')
  t.is(result[1].content, 'brown fox jumps', 'Second chunk should overlap with first')

  result.forEach((chunk, index) => {
    t.ok(chunk.id, `Chunk ${index} should have an ID`)
    t.ok(typeof chunk.id === 'string', `Chunk ${index} ID should be a string`)
  })
})

test('ChunkingService: should handle array input', async t => {
  const service = new ChunkingService({
    chunker: new LLMChunkAdapter({ splitStrategy: 'word' }),
    chunkOpts: { chunkSize: 10, chunkOverlap: 0 }
  })
  const input = [
    'First document here.',
    'Second document content.',
    'Third document text.'
  ]

  const result = await service.chunkText(input)

  t.ok(Array.isArray(result), 'Result should be an array')
  t.is(result.length, 3, 'Should create one chunk per input document')
})

test('ChunkingService: should handle invalid input', async t => {
  const service = new ChunkingService({
    chunker: new LLMChunkAdapter({ splitStrategy: 'word' })
  })

  try {
    await service.chunkText(123)
    t.fail('Should throw error when input is invalid')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
  }
})

test('LLMChunkAdapter: should use token splitStrategy by default', async t => {
  const adapter = new LLMChunkAdapter()
  const input = 'Hello world this is a test'
  const result = await adapter.chunkText(input, { chunkSize: 5, chunkOverlap: 0 })

  t.ok(Array.isArray(result), 'Result should be an array')
  t.ok(result.length >= 2, 'Should have at least 2 chunks')
  const allContent = result.map(r => r.content).join('')
  t.is(allContent, input, 'All chunks should reconstruct original text')
})

test('LLMChunkAdapter: should use character splitStrategy', async t => {
  const adapter = new LLMChunkAdapter({ splitStrategy: 'character' })
  const input = 'Hello'
  const result = await adapter.chunkText(input, { chunkSize: 3, chunkOverlap: 1 })

  t.ok(Array.isArray(result), 'Result should be an array')
  t.is(result[0].content, 'Hel', 'First chunk should be 3 characters')
  t.is(result[1].content, 'llo', 'Second chunk should overlap by 1 character')
})

test('LLMChunkAdapter: should use sentence splitStrategy', async t => {
  const adapter = new LLMChunkAdapter({ splitStrategy: 'sentence' })
  const input = 'Hello world! How are you? I am fine.'
  const result = await adapter.chunkText(input, { chunkSize: 2, chunkOverlap: 0 })

  t.ok(Array.isArray(result), 'Result should be an array')
  t.ok(result[0].content.includes('Hello world'), 'First chunk should contain first sentence')
})

test('LLMChunkAdapter: should use line splitStrategy', async t => {
  const adapter = new LLMChunkAdapter({ splitStrategy: 'line' })
  const input = 'Line one\nLine two\nLine three'
  const result = await adapter.chunkText(input, { chunkSize: 2, chunkOverlap: 0 })

  t.ok(Array.isArray(result), 'Result should be an array')
  t.ok(result[0].content.includes('Line one'), 'First chunk should contain first lines')
})

test('LLMChunkAdapter: should use custom splitter function', async t => {
  const customSplitter = (text) => text.split('-')
  const adapter = new LLMChunkAdapter({ splitter: customSplitter })
  const input = 'one-two-three-four-five'
  const result = await adapter.chunkText(input, { chunkSize: 2, chunkOverlap: 0 })

  t.ok(Array.isArray(result), 'Result should be an array')
  t.ok(result[0].content.includes('one'), 'Should use custom splitter')
})

test('LLMChunkAdapter: should override splitStrategy with runtime options', async t => {
  const adapter = new LLMChunkAdapter({ splitStrategy: 'word' })
  const input = 'Hello'
  const result = await adapter.chunkText(input, {
    splitStrategy: 'character',
    chunkSize: 3,
    chunkOverlap: 0
  })

  t.ok(Array.isArray(result), 'Result should be an array')
  t.is(result[0].content, 'Hel', 'Runtime splitStrategy should override constructor option')
})

test('LLMChunkAdapter: should allow runtime custom splitter to override default splitStrategy', async t => {
  // This tests the scenario where adapter has default splitStrategy: 'token'
  // and runtime opts provide a custom splitter (should not conflict)
  const adapter = new LLMChunkAdapter() // Has splitStrategy: 'token' by default
  const customSplitter = (text) => text.split('|')
  const input = 'AI|Machine Learning|Deep Learning'
  const result = await adapter.chunkText(input, {
    splitter: customSplitter,
    chunkSize: 2,
    chunkOverlap: 0
  })

  t.ok(Array.isArray(result), 'Result should be an array')
  t.ok(result[0].content.includes('AI'), 'Should use runtime custom splitter')
  t.ok(result[0].content.includes('Machine Learning'), 'Should chunk using custom splitter')
})

test('LLMChunkAdapter: should use token splitStrategy correctly', async t => {
  const adapter = new LLMChunkAdapter({ splitStrategy: 'token' })
  const input = 'The quick brown fox jumps over the lazy dog.'
  const result = await adapter.chunkText(input, { chunkSize: 5, chunkOverlap: 1 })

  t.ok(Array.isArray(result), 'Result should be an array')
  t.ok(result.length >= 2, 'Should create multiple chunks')

  // Verify chunks have expected overlap
  for (let i = 1; i < result.length; i++) {
    const prevChunk = result[i - 1].content
    const currChunk = result[i].content
    const prevTokens = tokenizeText(prevChunk).tokens.map(t => t.text)
    const currTokens = tokenizeText(currChunk).tokens.map(t => t.text)

    // With overlap of 1, last token of previous chunk should be first token of current chunk
    if (prevTokens.length > 0 && currTokens.length > 0) {
      t.is(prevTokens[prevTokens.length - 1], currTokens[0], 'Chunks should have correct overlap')
    }
  }
})

test('LLMChunkAdapter: token strategy should handle punctuation correctly', async t => {
  const adapter = new LLMChunkAdapter({ splitStrategy: 'token' })
  const input = "Don't forget: testing is important!"
  const result = await adapter.chunkText(input, { chunkSize: 4, chunkOverlap: 0 })

  t.ok(Array.isArray(result), 'Result should be an array')
  const allContent = result.map(r => r.content).join('')
  t.is(allContent, input, 'All chunks should reconstruct original text')

  // Token strategy should split contractions and punctuation
  t.ok(result.length >= 2, 'Should create multiple chunks due to tokenization')
})

test('LLMChunkAdapter: token strategy with URLs and special content', async t => {
  const adapter = new LLMChunkAdapter({ splitStrategy: 'token' })
  const input = 'Visit https://example.com for more info.'
  const result = await adapter.chunkText(input, { chunkSize: 6, chunkOverlap: 0 })

  t.ok(Array.isArray(result), 'Result should be an array')
  t.ok(result.length >= 2, 'URL should be split into multiple tokens creating multiple chunks')

  // Verify URL is preserved correctly
  const allContent = result.map(r => r.content).join('')
  t.is(allContent, input, 'URL should be preserved in reconstruction')
})

test('LLMChunkAdapter: token strategy with emojis', async t => {
  const adapter = new LLMChunkAdapter({ splitStrategy: 'token' })
  const input = 'Hello 🤚🏾 world!'
  const result = await adapter.chunkText(input, { chunkSize: 3, chunkOverlap: 0 })

  t.ok(Array.isArray(result), 'Result should be an array')
  t.ok(result.length >= 2, 'Emoji should affect chunking')

  const allContent = result.map(r => r.content).join('')
  t.is(allContent, input, 'Emoji should be preserved in reconstruction')
})

test('LLMChunkAdapter: should throw error for invalid chunk parameters', async t => {
  const adapter = new LLMChunkAdapter()

  const invalidSizes = [3.5, 0, -5]
  for (const size of invalidSizes) {
    try {
      await adapter.chunkText('test', { chunkSize: size, chunkOverlap: 0 })
      t.fail(`Should throw error for chunkSize: ${size}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      t.is(err.code, ERR_CODES.CHUNKING_FAILED, 'Error code should be CHUNKING_FAILED')
    }
  }

  const invalidOverlaps = [-1, 2.5]
  for (const overlap of invalidOverlaps) {
    try {
      await adapter.chunkText('test', { chunkSize: 10, chunkOverlap: overlap })
      t.fail(`Should throw error for chunkOverlap: ${overlap}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      t.is(err.code, ERR_CODES.CHUNKING_FAILED, 'Error code should be CHUNKING_FAILED')
    }
  }

  // chunkOverlap >= chunkSize
  try {
    await adapter.chunkText('test', { chunkSize: 5, chunkOverlap: 5 })
    t.fail('Should throw error when chunkOverlap equals chunkSize')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.CHUNKING_FAILED, 'Error code should be CHUNKING_FAILED')
  }

  // Invalid chunkStrategy
  try {
    await adapter.chunkText('test', { chunkSize: 10, chunkOverlap: 0, chunkStrategy: 'invalid' })
    t.fail('Should throw error for invalid chunkStrategy')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.CHUNKING_FAILED, 'Error code should be CHUNKING_FAILED')
  }
})

test('LLMChunkAdapter: should throw error for invalid splitStrategy', async t => {
  const adapter = new LLMChunkAdapter()

  try {
    await adapter.chunkText('test', { chunkSize: 10, chunkOverlap: 0, splitStrategy: 'invalid' })
    t.fail('Should throw error for invalid splitStrategy')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.INVALID_PARAMS, 'Error code should be INVALID_PARAMS')
    t.ok(err.message.includes('splitStrategy must be one of'), 'Error message should list valid options')
  }
})

test('LLMChunkAdapter: should throw error for non-function splitter', async t => {
  const adapter = new LLMChunkAdapter()

  try {
    await adapter.chunkText('test', { chunkSize: 10, chunkOverlap: 0, splitter: 'not-a-function' })
    t.fail('Should throw error for non-function splitter')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.CHUNKING_FAILED, 'Error code should be CHUNKING_FAILED (validated by llm-splitter)')
    t.ok(err.message.length > 0, 'Error should have a message')
  }
})

test('LLMChunkAdapter: should prioritize splitter over splitStrategy when both provided', async t => {
  const adapter = new LLMChunkAdapter()
  const customSplitter = (text) => text.split('-') // Split by dash

  const result = await adapter.chunkText('one-two-three-four', {
    chunkSize: 2,
    chunkOverlap: 0,
    splitStrategy: 'word', // This should be ignored
    splitter: customSplitter // This should be used
  })

  t.ok(Array.isArray(result), 'Result should be an array')
  t.ok(result[0].content.includes('one'), 'Should use custom splitter, not word splitting')
  t.ok(result[0].content.includes('two'), 'Should chunk using custom splitter')
})

test('LLMChunkAdapter: should handle emoji and Unicode text', async t => {
  const adapter = new LLMChunkAdapter({ splitStrategy: 'word' })
  const unicodeText = '🌟 Hello 世界 café résumé 🚀 test 中文 💯'
  const result = await adapter.chunkText(unicodeText, { chunkSize: 4, chunkOverlap: 0 })

  t.ok(Array.isArray(result), 'Result should be an array')
  t.ok(result.length > 0, 'Should create at least one chunk')

  const allContent = result.map(chunk => chunk.content).join(' ')
  t.ok(allContent.includes('🌟'), 'Should preserve emojis')
  t.ok(allContent.includes('世界'), 'Should preserve Chinese characters')
  t.ok(allContent.includes('café'), 'Should preserve accented characters')
})
