import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createVectorStoresStore,
  generateVectorStoreId,
  idToWorkspace,
  InvalidVectorStoreIdError
} from '../src/serve/adapters/openai/vector-stores-store.js'

describe('generateVectorStoreId', () => {
  it('returns a vs_-prefixed id of expected length', () => {
    const id = generateVectorStoreId()
    assert.match(id, /^vs_[0-9a-f]{24}$/)
  })

  it('produces unique ids across calls', () => {
    const a = generateVectorStoreId()
    const b = generateVectorStoreId()
    assert.notEqual(a, b)
  })
})

describe('idToWorkspace', () => {
  it('accepts safe alphanumeric ids with - and _', () => {
    assert.equal(idToWorkspace('vs_abc-123_XYZ'), 'vs_abc-123_XYZ')
  })

  it('rejects path traversal sequences', () => {
    assert.throws(() => idToWorkspace('..'), InvalidVectorStoreIdError)
    assert.throws(() => idToWorkspace('vs/../etc'), InvalidVectorStoreIdError)
    assert.throws(() => idToWorkspace('vs\\evil'), InvalidVectorStoreIdError)
    assert.throws(() => idToWorkspace('vs\0name'), InvalidVectorStoreIdError)
  })

  it('rejects oversized ids', () => {
    assert.throws(() => idToWorkspace('a'.repeat(65)), InvalidVectorStoreIdError)
  })

  it('rejects empty and non-string', () => {
    assert.throws(() => idToWorkspace(''), InvalidVectorStoreIdError)
    assert.throws(() => idToWorkspace(undefined as unknown as string), InvalidVectorStoreIdError)
  })

  it('rejects characters outside the safe set', () => {
    assert.throws(() => idToWorkspace('vs.abc'), InvalidVectorStoreIdError)
    assert.throws(() => idToWorkspace('vs abc'), InvalidVectorStoreIdError)
    assert.throws(() => idToWorkspace('vs!abc'), InvalidVectorStoreIdError)
  })
})

describe('createVectorStoresStore', () => {
  it('create returns a meta with a generated id when none is supplied', () => {
    const store = createVectorStoresStore(() => 1_700_000_000_000)
    const meta = store.create({ name: 'docs' })
    assert.match(meta.id, /^vs_[0-9a-f]{24}$/)
    assert.equal(meta.name, 'docs')
    assert.equal(meta.createdAt, 1_700_000_000_000)
    assert.equal(meta.lastActiveAt, 1_700_000_000_000)
    assert.equal(meta.expiresAfter, null)
    assert.equal(meta.expiresAt, null)
    assert.deepEqual(meta.metadata, {})
  })

  it('create uses the provided id when valid', () => {
    const store = createVectorStoresStore()
    const meta = store.create({ id: 'vs_my-store' })
    assert.equal(meta.id, 'vs_my-store')
  })

  it('create rejects an invalid id', () => {
    const store = createVectorStoresStore()
    assert.throws(() => store.create({ id: 'vs/bad' }), InvalidVectorStoreIdError)
  })

  it('create with expires_after computes expires_at', () => {
    const store = createVectorStoresStore(() => 1_000)
    const meta = store.create({ expiresAfter: { anchor: 'last_active_at', days: 1 } })
    assert.equal(meta.expiresAt, 1_000 + 86_400_000)
  })

  it('refuses to overwrite an existing id', () => {
    const store = createVectorStoresStore()
    store.create({ id: 'vs_dup' })
    assert.throws(() => store.create({ id: 'vs_dup' }), InvalidVectorStoreIdError)
  })

  it('get returns a clone (mutations do not leak)', () => {
    const store = createVectorStoresStore()
    const meta = store.create({ name: 'a', metadata: { k: 'v' } })
    const fetched = store.get(meta.id)
    assert.ok(fetched)
    fetched.metadata['k'] = 'mutated'
    fetched.name = 'changed'
    const fresh = store.get(meta.id)
    assert.ok(fresh)
    assert.equal(fresh.metadata['k'], 'v')
    assert.equal(fresh.name, 'a')
  })

  it('get returns null for missing', () => {
    const store = createVectorStoresStore()
    assert.equal(store.get('vs_missing'), null)
  })

  it('update merges name, metadata, and expires_after', () => {
    let now = 1_000
    const store = createVectorStoresStore(() => now)
    const meta = store.create({ name: 'a', metadata: { k: 'v' } })
    now = 2_000
    const updated = store.update(meta.id, {
      name: 'b',
      metadata: { x: 'y' },
      expiresAfter: { anchor: 'last_active_at', days: 2 }
    })
    assert.ok(updated)
    assert.equal(updated.name, 'b')
    assert.deepEqual(updated.metadata, { x: 'y' })
    assert.deepEqual(updated.expiresAfter, { anchor: 'last_active_at', days: 2 })
  })

  it('update with metadata=null clears the map', () => {
    const store = createVectorStoresStore()
    const meta = store.create({ metadata: { a: '1' } })
    const updated = store.update(meta.id, { metadata: null })
    assert.ok(updated)
    assert.deepEqual(updated.metadata, {})
  })

  it('update returns null for unknown id', () => {
    const store = createVectorStoresStore()
    assert.equal(store.update('vs_missing', { name: 'x' }), null)
  })

  it('delete returns true when present, false otherwise', () => {
    const store = createVectorStoresStore()
    const meta = store.create()
    assert.equal(store.delete(meta.id), true)
    assert.equal(store.delete(meta.id), false)
  })

  it('list returns entries sorted by createdAt descending', () => {
    let t = 1_000
    const store = createVectorStoresStore(() => t++)
    store.create({ id: 'vs_first' })
    store.create({ id: 'vs_second' })
    store.create({ id: 'vs_third' })
    const ids = store.list().map((s) => s.id)
    assert.deepEqual(ids, ['vs_third', 'vs_second', 'vs_first'])
  })

  it('touch updates lastActiveAt and recomputes expiresAt', () => {
    let now = 1_000
    const store = createVectorStoresStore(() => now)
    const meta = store.create({ expiresAfter: { anchor: 'last_active_at', days: 1 } })
    assert.equal(meta.expiresAt, 1_000 + 86_400_000)
    now = 5_000
    store.touch(meta.id)
    const fresh = store.get(meta.id)
    assert.ok(fresh)
    assert.equal(fresh.lastActiveAt, 5_000)
    assert.equal(fresh.expiresAt, 5_000 + 86_400_000)
  })

  it('touch on missing id is a no-op', () => {
    const store = createVectorStoresStore()
    assert.doesNotThrow(() => store.touch('vs_missing'))
  })

  it('create initializes embeddingAlias to null', () => {
    const store = createVectorStoresStore()
    const meta = store.create()
    assert.equal(meta.embeddingAlias, null)
  })

  it('setEmbedding records the alias on a known id', () => {
    const store = createVectorStoresStore()
    const meta = store.create()
    store.setEmbedding(meta.id, 'gte-large-fp16')
    const fresh = store.get(meta.id)
    assert.ok(fresh)
    assert.equal(fresh.embeddingAlias, 'gte-large-fp16')
  })

  it('setEmbedding is idempotent (never overwrites an existing alias)', () => {
    const store = createVectorStoresStore()
    const meta = store.create()
    store.setEmbedding(meta.id, 'first-model')
    store.setEmbedding(meta.id, 'second-model')
    const fresh = store.get(meta.id)
    assert.ok(fresh)
    assert.equal(fresh.embeddingAlias, 'first-model')
  })

  it('setEmbedding on missing id is a no-op', () => {
    const store = createVectorStoresStore()
    assert.doesNotThrow(() => store.setEmbedding('vs_missing', 'whatever'))
  })

  it('get returns a clone — mutating embeddingAlias on the result does not leak', () => {
    const store = createVectorStoresStore()
    const meta = store.create()
    store.setEmbedding(meta.id, 'a')
    const fetched = store.get(meta.id)
    assert.ok(fetched)
    fetched.embeddingAlias = 'b'
    const fresh = store.get(meta.id)
    assert.ok(fresh)
    assert.equal(fresh.embeddingAlias, 'a')
  })
})
