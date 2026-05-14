import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createChunkAttributionStore } from '../src/serve/adapters/openai/chunk-attribution-store.js'

describe('createChunkAttributionStore', () => {
  it('records and looks up attribution under a vector store id', () => {
    const store = createChunkAttributionStore()
    store.record('vs_a', 'chunk_1', { fileId: 'file-abc', fileName: 'notes.txt' })
    const found = store.lookup('vs_a', 'chunk_1')
    assert.deepEqual(found, { fileId: 'file-abc', fileName: 'notes.txt' })
  })

  it('returns null for unknown chunk or unknown store', () => {
    const store = createChunkAttributionStore()
    assert.equal(store.lookup('vs_a', 'chunk_missing'), null)
    assert.equal(store.lookup('vs_missing', 'chunk_anything'), null)
  })

  it('scopes attributions per vector store id (no cross-talk)', () => {
    const store = createChunkAttributionStore()
    store.record('vs_a', 'chunk_shared', { fileId: 'file-a', fileName: 'a.txt' })
    store.record('vs_b', 'chunk_shared', { fileId: 'file-b', fileName: 'b.txt' })
    assert.deepEqual(store.lookup('vs_a', 'chunk_shared'), { fileId: 'file-a', fileName: 'a.txt' })
    assert.deepEqual(store.lookup('vs_b', 'chunk_shared'), { fileId: 'file-b', fileName: 'b.txt' })
  })

  it('latest record wins for the same (vs, chunk) pair', () => {
    const store = createChunkAttributionStore()
    store.record('vs_a', 'chunk_1', { fileId: 'file-old', fileName: 'old.txt' })
    store.record('vs_a', 'chunk_1', { fileId: 'file-new', fileName: 'new.txt' })
    assert.deepEqual(store.lookup('vs_a', 'chunk_1'), { fileId: 'file-new', fileName: 'new.txt' })
  })

  it('evict drops every attribution for a vector store', () => {
    const store = createChunkAttributionStore()
    store.record('vs_a', 'chunk_1', { fileId: 'file-1', fileName: 'a.txt' })
    store.record('vs_a', 'chunk_2', { fileId: 'file-2', fileName: 'b.txt' })
    store.record('vs_b', 'chunk_1', { fileId: 'file-3', fileName: 'c.txt' })
    store.evict('vs_a')
    assert.equal(store.lookup('vs_a', 'chunk_1'), null)
    assert.equal(store.lookup('vs_a', 'chunk_2'), null)
    // Other vs untouched.
    assert.deepEqual(store.lookup('vs_b', 'chunk_1'), { fileId: 'file-3', fileName: 'c.txt' })
  })

  it('lookup returns a defensive clone (callers cannot mutate stored entries)', () => {
    const store = createChunkAttributionStore()
    store.record('vs_a', 'chunk_1', { fileId: 'file-abc', fileName: 'notes.txt' })
    const found = store.lookup('vs_a', 'chunk_1')
    assert.ok(found)
    found.fileId = 'tampered'
    found.fileName = 'tampered'
    const fresh = store.lookup('vs_a', 'chunk_1')
    assert.deepEqual(fresh, { fileId: 'file-abc', fileName: 'notes.txt' })
  })
})
