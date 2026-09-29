import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createJobsStore, type JobEvictReason } from '@/serve/core/stores/jobs'

interface Job {
  id: string
  createdAt: number
  status?: string
}

function seed(count: number, maxEntries?: number): ReturnType<typeof createJobsStore<Job>> {
  const store = createJobsStore<Job>({
    ...(maxEntries !== undefined ? { maxEntries } : {}),
    createdAt: (job) => job.createdAt
  })
  for (let i = 0; i < count; i++) store.add({ id: `j${i}`, createdAt: i })
  return store
}

describe('createJobsStore', () => {
  it('defaults maxEntries to 256', () => {
    const store = seed(257)
    assert.equal(store.maxEntries, 256)
    assert.equal(store.size(), 256)
    assert.equal(store.get('j0'), undefined)
    assert.notEqual(store.get('j256'), undefined)
  })

  it('evicts oldest by insertion and reports each eviction', () => {
    const evicted: Array<[string, JobEvictReason]> = []
    const store = createJobsStore<Job>({
      maxEntries: 2,
      createdAt: (job) => job.createdAt,
      onEvict: (job, reason) => evicted.push([job.id, reason])
    })
    store.add({ id: 'a', createdAt: 3 })
    store.add({ id: 'b', createdAt: 1 })
    store.add({ id: 'c', createdAt: 2 })
    assert.deepEqual(evicted, [['a', 'max_entries']])
    assert.equal(store.size(), 2)
    assert.equal(store.get('a'), undefined)
  })

  it('update merges a patch in place and misses unknown ids', () => {
    const store = seed(1)
    const updated = store.update('j0', { status: 'done' })
    assert.equal(updated?.status, 'done')
    assert.equal(store.get('j0')?.status, 'done')
    assert.equal(store.update('missing', { status: 'done' }), undefined)
  })

  it('delete removes a job and reports whether it existed', () => {
    const store = seed(1)
    assert.equal(store.delete('j0'), true)
    assert.equal(store.delete('j0'), false)
    assert.equal(store.size(), 0)
  })

  it('lists newest first with a limit of 20 by default', () => {
    const page = seed(25).list()
    assert.equal(page.items.length, 20)
    assert.equal(page.firstId, 'j24')
    assert.equal(page.lastId, 'j5')
    assert.equal(page.hasMore, true)
  })

  it('caps limit at 100 and falls back to 20 for non-positive limits', () => {
    const store = seed(150)
    assert.equal(store.list({ limit: 500 }).items.length, 100)
    assert.equal(store.list({ limit: 0 }).items.length, 20)
  })

  it('lists oldest first for asc order', () => {
    const page = seed(3).list({ order: 'asc' })
    assert.deepEqual(
      page.items.map((j) => j.id),
      ['j0', 'j1', 'j2']
    )
    assert.equal(page.hasMore, false)
  })

  it('pages with the after cursor', () => {
    const store = seed(5)
    const next = store.list({ limit: 2, after: 'j3' })
    assert.deepEqual(
      next.items.map((j) => j.id),
      ['j2', 'j1']
    )
    assert.equal(next.hasMore, true)
    const last = store.list({ limit: 2, after: 'j1' })
    assert.deepEqual(
      last.items.map((j) => j.id),
      ['j0']
    )
    assert.equal(last.hasMore, false)
  })

  it('returns an empty page for an unknown after cursor', () => {
    const page = seed(3).list({ after: 'missing' })
    assert.deepEqual(page.items, [])
    assert.equal(page.firstId, null)
    assert.equal(page.lastId, null)
    assert.equal(page.hasMore, false)
  })
})
