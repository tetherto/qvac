'use strict'

const test = require('brittle')
const { normalizeDocs, generateId, createLRUCache } = require('../../src/utils/helper')
const { QvacErrorRAG, ERR_CODES } = require('../../src/errors')

test('normalizeDocs: should handle empty array input', t => {
  const result = normalizeDocs([])
  t.ok(Array.isArray(result.normalizedDocs), 'normalizedDocs should be an array')
  t.is(result.normalizedDocs.length, 0, 'normalizedDocs should be empty')
  t.ok(Array.isArray(result.droppedIndices), 'droppedIndices should be an array')
  t.is(result.droppedIndices.length, 0, 'droppedIndices should be empty')
})

test('normalizeDocs: should throw error for non-array input', t => {
  const invalidInputs = [null, undefined, 'string', 123, {}, true]

  invalidInputs.forEach(input => {
    try {
      normalizeDocs(input)
      t.fail(`Should throw error for input: ${input}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
    }
  })
})

test('normalizeDocs: should convert string inputs to document objects', t => {
  const docs = ['Document 1', 'Document 2', 'Document 3']
  const result = normalizeDocs(docs)

  t.is(result.normalizedDocs.length, 3, 'Should have 3 normalized documents')
  t.is(result.droppedIndices.length, 0, 'Should have no dropped indices')

  result.normalizedDocs.forEach((doc, index) => {
    t.is(doc.content, docs[index], `Document ${index} content should match`)
    t.ok(doc.id, `Document ${index} should have an ID`)
    t.ok(typeof doc.id === 'string', `Document ${index} ID should be a string`)
  })
})

test('normalizeDocs: should preserve existing document objects with content', t => {
  const docs = [
    { content: 'Doc 1', id: 'doc1' },
    { content: 'Doc 2', id: 'doc2', metadata: { type: 'test' } },
    { content: 'Doc 3' } // No ID, should get generated
  ]
  const result = normalizeDocs(docs)

  t.is(result.normalizedDocs.length, 3, 'Should have 3 normalized documents')
  t.is(result.droppedIndices.length, 0, 'Should have no dropped indices')

  t.is(result.normalizedDocs[0].id, 'doc1', 'First doc should preserve existing ID')
  t.is(result.normalizedDocs[0].content, 'Doc 1', 'First doc should preserve content')

  t.is(result.normalizedDocs[1].id, 'doc2', 'Second doc should preserve existing ID')
  t.is(result.normalizedDocs[1].metadata.type, 'test', 'Second doc should preserve metadata')

  t.ok(result.normalizedDocs[2].id, 'Third doc should have generated ID')
  t.is(result.normalizedDocs[2].content, 'Doc 3', 'Third doc should preserve content')
})

test('normalizeDocs: should drop invalid documents and track indices', t => {
  const docs = [
    'Valid string doc',
    null,
    { content: 'Valid object doc' },
    undefined,
    {},
    { id: 'doc-with-no-content' },
    'Another valid string',
    42
  ]
  const result = normalizeDocs(docs)

  t.is(result.normalizedDocs.length, 3, 'Should have 3 valid documents')
  t.is(result.droppedIndices.length, 5, 'Should have 5 dropped indices')

  // Check dropped indices are correct
  const expectedDroppedIndices = [1, 3, 4, 5, 7]
  t.alike(result.droppedIndices, expectedDroppedIndices, 'Should track correct dropped indices')

  // Check valid documents
  t.is(result.normalizedDocs[0].content, 'Valid string doc', 'First valid doc should be correct')
  t.is(result.normalizedDocs[1].content, 'Valid object doc', 'Second valid doc should be correct')
  t.is(result.normalizedDocs[2].content, 'Another valid string', 'Third valid doc should be correct')
})

test('normalizeDocs: should throw error for duplicate IDs', t => {
  const docs = [
    { content: 'Doc 1', id: 'duplicate-id' },
    { content: 'Doc 2', id: 'unique-id' },
    { content: 'Doc 3', id: 'duplicate-id' }
  ]

  try {
    normalizeDocs(docs)
    t.fail('Should throw error for duplicate IDs')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.DUPLICATE_DOCUMENT_ID, 'Error code should be DUPLICATE_DOCUMENT_ID')
    t.ok(err.message.includes('duplicate-id'), 'Error message should include the duplicate ID')
  }
})

test('normalizeDocs: should handle edge case documents', t => {
  const docs = [
    { content: '' }, // Empty content is invalid, will be dropped
    { content: '   ' }, // Whitespace-only content is invalid, will be dropped
    { content: 'Normal content', id: '' }, // Empty ID should get replaced
    { content: 'Content', id: null }, // Null ID should get replaced
    { content: 'Content', id: undefined } // Undefined ID should get replaced
  ]

  const result = normalizeDocs(docs)

  t.is(result.normalizedDocs.length, 3, 'Should have 3 normalized documents (empty and whitespace-only content dropped)')
  t.alike(result.droppedIndices, [0, 1], 'Should have dropped the empty and whitespace-only content documents')

  // All should have generated IDs since empty/null/undefined IDs are replaced
  result.normalizedDocs.forEach((doc, index) => {
    t.ok(doc.id && doc.id.length > 0, `Document ${index} should have a non-empty ID`)
    t.ok(typeof doc.id === 'string', `Document ${index} ID should be a string`)
  })
})

test('normalizeDocs: should preserve additional properties', t => {
  const docs = [
    {
      content: 'Test content',
      id: 'test-doc',
      metadata: { author: 'John', date: '2023-01-01' },
      tags: ['test', 'document'],
      score: 0.95
    }
  ]

  const result = normalizeDocs(docs)

  t.is(result.normalizedDocs.length, 1, 'Should have 1 normalized document')
  const doc = result.normalizedDocs[0]

  t.is(doc.content, 'Test content', 'Content should be preserved')
  t.is(doc.id, 'test-doc', 'ID should be preserved')
  t.alike(doc.metadata, { author: 'John', date: '2023-01-01' }, 'Metadata should be preserved')
  t.alike(doc.tags, ['test', 'document'], 'Tags should be preserved')
  t.is(doc.score, 0.95, 'Score should be preserved')
})

test('generateId: should generate valid UUID v4 strings', t => {
  const id1 = generateId()
  const id2 = generateId()

  // UUID v4 pattern: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  t.ok(typeof id1 === 'string', 'Generated ID should be a string')
  t.ok(typeof id2 === 'string', 'Generated ID should be a string')
  t.ok(uuidPattern.test(id1), 'First ID should match UUID v4 pattern')
  t.ok(uuidPattern.test(id2), 'Second ID should match UUID v4 pattern')
  t.not(id1, id2, 'Generated IDs should be unique')
})

test('generateId: should generate multiple unique IDs', t => {
  const ids = new Set()
  const count = 100

  for (let i = 0; i < count; i++) {
    ids.add(generateId())
  }

  t.is(ids.size, count, 'All generated IDs should be unique')
})

test('normalizeDocs: comprehensive mixed scenario', t => {
  const docs = [
    'String document 1',
    { content: 'Object document 1', id: 'obj1' },
    null,
    'String document 2',
    { content: 'Object document 2' }, // No ID
    {},
    { id: 'no-content' },
    { content: 'Object document 3', id: 'obj3', extra: 'data' },
    undefined,
    42
  ]

  const result = normalizeDocs(docs)

  t.is(result.normalizedDocs.length, 5, 'Should have 5 valid documents')
  t.alike(result.droppedIndices, [2, 5, 6, 8, 9], 'Should track correct dropped indices')

  // Verify valid documents
  t.is(result.normalizedDocs[0].content, 'String document 1', 'First doc should be correct')
  t.ok(result.normalizedDocs[0].id, 'First doc should have generated ID')

  t.is(result.normalizedDocs[1].content, 'Object document 1', 'Second doc should be correct')
  t.is(result.normalizedDocs[1].id, 'obj1', 'Second doc should preserve ID')

  t.is(result.normalizedDocs[2].content, 'String document 2', 'Third doc should be correct')
  t.ok(result.normalizedDocs[2].id, 'Third doc should have generated ID')

  t.is(result.normalizedDocs[3].content, 'Object document 2', 'Fourth doc should be correct')
  t.ok(result.normalizedDocs[3].id, 'Fourth doc should have generated ID')

  t.is(result.normalizedDocs[4].content, 'Object document 3', 'Fifth doc should be correct')
  t.is(result.normalizedDocs[4].id, 'obj3', 'Fifth doc should preserve ID')
  t.is(result.normalizedDocs[4].extra, 'data', 'Fifth doc should preserve extra properties')
})

// LRU Cache Tests

test('createLRUCache: should store and retrieve values', t => {
  const cache = createLRUCache(3)

  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3)

  t.is(cache.get('a'), 1, 'Should retrieve value for key a')
  t.is(cache.get('b'), 2, 'Should retrieve value for key b')
  t.is(cache.get('c'), 3, 'Should retrieve value for key c')
  t.is(cache.size, 3, 'Cache size should be 3')
})

test('createLRUCache: should return undefined for missing keys', t => {
  const cache = createLRUCache(3)

  cache.set('a', 1)

  t.is(cache.get('missing'), undefined, 'Should return undefined for missing key')
  t.is(cache.has('a'), true, 'has() should return true for existing key')
  t.is(cache.has('missing'), false, 'has() should return false for missing key')
})

test('createLRUCache: should evict LRU item when capacity exceeded', t => {
  const cache = createLRUCache(3)

  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3)
  cache.set('d', 4) // Should evict 'a' (oldest)

  t.is(cache.get('a'), undefined, 'Oldest item (a) should be evicted')
  t.is(cache.get('b'), 2, 'Item b should still exist')
  t.is(cache.get('c'), 3, 'Item c should still exist')
  t.is(cache.get('d'), 4, 'New item d should exist')
  t.is(cache.size, 3, 'Cache size should remain at max')
})

test('createLRUCache: get() should move item to most recently used', t => {
  const cache = createLRUCache(3)

  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3)

  // Access 'a' to make it most recently used
  cache.get('a')

  // Add new item - should evict 'b' (now the LRU), not 'a'
  cache.set('d', 4)

  t.is(cache.get('a'), 1, 'Accessed item (a) should still exist')
  t.is(cache.get('b'), undefined, 'LRU item (b) should be evicted')
  t.is(cache.get('c'), 3, 'Item c should still exist')
  t.is(cache.get('d'), 4, 'New item d should exist')
})

test('createLRUCache: set() should update existing key and move to MRU', t => {
  const cache = createLRUCache(3)

  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3)

  // Update 'a' with new value
  cache.set('a', 100)

  // Add new item - should evict 'b' (now the LRU), not 'a'
  cache.set('d', 4)

  t.is(cache.get('a'), 100, 'Updated item (a) should have new value')
  t.is(cache.get('b'), undefined, 'LRU item (b) should be evicted')
  t.is(cache.size, 3, 'Cache size should remain at max')
})

test('createLRUCache: delete() should remove item', t => {
  const cache = createLRUCache(3)

  cache.set('a', 1)
  cache.set('b', 2)

  t.is(cache.delete('a'), true, 'delete() should return true for existing key')
  t.is(cache.get('a'), undefined, 'Deleted item should not exist')
  t.is(cache.size, 1, 'Cache size should decrease')
  t.is(cache.delete('missing'), false, 'delete() should return false for missing key')
})

test('createLRUCache: clear() should remove all items', t => {
  const cache = createLRUCache(3)

  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3)

  cache.clear()

  t.is(cache.size, 0, 'Cache should be empty after clear')
  t.is(cache.get('a'), undefined, 'All items should be removed')
  t.is(cache.get('b'), undefined, 'All items should be removed')
  t.is(cache.get('c'), undefined, 'All items should be removed')
})

test('createLRUCache: should handle capacity of 1', t => {
  const cache = createLRUCache(1)

  cache.set('a', 1)
  t.is(cache.get('a'), 1, 'Should store single item')

  cache.set('b', 2)
  t.is(cache.get('a'), undefined, 'Previous item should be evicted')
  t.is(cache.get('b'), 2, 'New item should exist')
  t.is(cache.size, 1, 'Cache size should be 1')
})

test('createLRUCache: should handle complex values', t => {
  const cache = createLRUCache(3)

  const obj = { id: 1, data: [1, 2, 3] }
  const arr = [0.1, 0.2, 0.3, 0.4]

  cache.set('obj', obj)
  cache.set('arr', arr)
  cache.set('null', null)

  t.alike(cache.get('obj'), obj, 'Should store objects')
  t.alike(cache.get('arr'), arr, 'Should store arrays')
  t.is(cache.get('null'), null, 'Should store null')
})
