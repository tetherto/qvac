import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createEphemeralFilesStore } from '../src/serve/adapters/openai/ephemeral-files-store.js'

describe('createEphemeralFilesStore', () => {
  it('put returns a file- prefixed id and get returns the same bytes', () => {
    const clock = () => 1_700_000_000_000
    const store = createEphemeralFilesStore(clock)
    const id = store.put({
      data: Buffer.from('hello', 'utf8'),
      fileName: 'a.txt',
      purpose: 'assistants'
    })
    assert.match(id, /^file-[0-9a-f]{24}$/)
    const got = store.get(id)
    assert.notEqual(got, null)
    if (got === null) return
    assert.equal(got.data.toString('utf8'), 'hello')
    assert.equal(got.fileName, 'a.txt')
    assert.equal(got.purpose, 'assistants')
    assert.equal(got.contentType, 'application/octet-stream')
    assert.equal(got.createdAtMs, 1_700_000_000_000)
    assert.equal(got.expiresAtMs, 1_700_000_000_000 + 60 * 60 * 1000)
  })

  it('expiresAtMs is null when ttl is disabled', () => {
    const clock = () => 1_000
    const store = createEphemeralFilesStore(clock, { ttlMs: 0 })
    const id = store.put({ data: Buffer.from('x'), fileName: 'x', purpose: 'p' })
    const got = store.get(id)
    assert.notEqual(got, null)
    if (got !== null) assert.equal(got.expiresAtMs, null)
  })

  it('put honors an explicit contentType', () => {
    const store = createEphemeralFilesStore()
    const id = store.put({
      data: Buffer.from([0]),
      fileName: 'img.png',
      purpose: 'image_generation',
      contentType: 'image/png'
    })
    const got = store.get(id)
    assert.notEqual(got, null)
    if (got !== null) assert.equal(got.contentType, 'image/png')
  })

  it('remove drops the entry', () => {
    const store = createEphemeralFilesStore()
    const id = store.put({
      data: Buffer.from('x'),
      fileName: 'b.txt',
      purpose: 'assistants'
    })
    store.remove(id)
    assert.equal(store.get(id), null)
  })

  it('list returns entries newest-first', () => {
    let t = 1_000
    const store = createEphemeralFilesStore(() => t)
    t = 1_000; const idOld = store.put({ data: Buffer.from('a'), fileName: 'a.txt', purpose: 'assistants' })
    t = 2_000; const idNew = store.put({ data: Buffer.from('b'), fileName: 'b.txt', purpose: 'assistants' })
    const listed = store.list().map((e) => e.id)
    assert.deepEqual(listed, [idNew, idOld])
  })

  it('evicts oldest entries when maxFiles is exceeded', () => {
    let t = 1_000
    const store = createEphemeralFilesStore(() => t, { maxFiles: 2, ttlMs: 0 })
    t = 1_000; const a = store.put({ data: Buffer.from('a'), fileName: 'a', purpose: 'p' })
    t = 2_000; const b = store.put({ data: Buffer.from('b'), fileName: 'b', purpose: 'p' })
    t = 3_000; const c = store.put({ data: Buffer.from('c'), fileName: 'c', purpose: 'p' })
    assert.equal(store.get(a), null)
    assert.notEqual(store.get(b), null)
    assert.notEqual(store.get(c), null)
  })

  it('evicts oldest entries when maxBytes is exceeded', () => {
    let t = 1_000
    const store = createEphemeralFilesStore(() => t, { maxBytes: 8, ttlMs: 0 })
    t = 1_000; const a = store.put({ data: Buffer.alloc(5), fileName: 'a', purpose: 'p' })
    t = 2_000; const b = store.put({ data: Buffer.alloc(5), fileName: 'b', purpose: 'p' })
    assert.equal(store.get(a), null)
    assert.notEqual(store.get(b), null)
  })

  it('evicts entries past their TTL on get', () => {
    let t = 1_000
    const store = createEphemeralFilesStore(() => t, { ttlMs: 1_000 })
    t = 1_000
    const id = store.put({ data: Buffer.from('x'), fileName: 'x', purpose: 'p' })
    t = 1_500
    assert.notEqual(store.get(id), null)
    t = 5_000
    assert.equal(store.get(id), null)
  })

  it('fires onEvict with reason="ttl" when an expired record is read', () => {
    let t = 1_000
    const evictions: Array<{ id: string; reason: string }> = []
    const store = createEphemeralFilesStore(() => t, {
      ttlMs: 1_000,
      onEvict: (id, reason) => evictions.push({ id, reason })
    })
    t = 1_000
    const a = store.put({ data: Buffer.from('a'), fileName: 'a', purpose: 'p' })
    t = 5_000
    assert.equal(store.get(a), null)
    assert.deepEqual(evictions, [{ id: a, reason: 'ttl' }])
  })

  it('fires onEvict with reason="max_files" when the file count cap is hit', () => {
    let t = 1_000
    const evictions: Array<{ id: string; reason: string }> = []
    const store = createEphemeralFilesStore(() => t, {
      ttlMs: 0,
      maxFiles: 2,
      onEvict: (id, reason) => evictions.push({ id, reason })
    })
    t = 1_000; const a = store.put({ data: Buffer.from('a'), fileName: 'a', purpose: 'p' })
    t = 2_000; store.put({ data: Buffer.from('b'), fileName: 'b', purpose: 'p' })
    t = 3_000; store.put({ data: Buffer.from('c'), fileName: 'c', purpose: 'p' })
    assert.deepEqual(evictions, [{ id: a, reason: 'max_files' }])
  })

  it('fires onEvict with reason="max_bytes" when the byte cap is hit', () => {
    let t = 1_000
    const evictions: Array<{ id: string; reason: string }> = []
    const store = createEphemeralFilesStore(() => t, {
      ttlMs: 0,
      maxBytes: 8,
      onEvict: (id, reason) => evictions.push({ id, reason })
    })
    t = 1_000; const a = store.put({ data: Buffer.alloc(5), fileName: 'a', purpose: 'p' })
    t = 2_000; store.put({ data: Buffer.alloc(5), fileName: 'b', purpose: 'p' })
    assert.deepEqual(evictions, [{ id: a, reason: 'max_bytes' }])
  })
})
