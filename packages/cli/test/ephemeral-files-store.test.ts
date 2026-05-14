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
    assert.equal(got.createdAtMs, 1_700_000_000_000)
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
})
