import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createResponsesStore } from '../src/serve/adapters/openai/responses-store.js'

describe('createResponsesStore', () => {
  it('put then get returns record', () => {
    const store = createResponsesStore({ maxEntries: 10, ttlMs: 60_000 })
    const rec = {
      id: 'resp_a',
      createdAtSec: 100,
      expiresAtSec: 2_000_000_000,
      responseObject: { id: 'resp_a', object: 'response' },
      inputItems: [{ type: 'message', id: '1', role: 'user', content: [] }],
      modelAlias: 'm'
    }
    store.put(rec)
    const got = store.get('resp_a')
    assert.ok(got)
    assert.equal(got!.id, 'resp_a')
  })

  it('delete removes record', () => {
    const store = createResponsesStore({ maxEntries: 10, ttlMs: 60_000 })
    store.put({
      id: 'resp_b',
      createdAtSec: 1,
      expiresAtSec: 2_000_000_000,
      responseObject: {},
      inputItems: [],
      modelAlias: 'm'
    })
    assert.equal(store.delete('resp_b'), true)
    assert.equal(store.get('resp_b'), undefined)
  })

  it('evicts oldest when over maxEntries', () => {
    const store = createResponsesStore({ maxEntries: 2, ttlMs: 600_000 })
    store.put({
      id: 'resp_1',
      createdAtSec: 1,
      expiresAtSec: 2_000_000_000,
      responseObject: {},
      inputItems: [],
      modelAlias: 'm'
    })
    store.put({
      id: 'resp_2',
      createdAtSec: 2,
      expiresAtSec: 2_000_000_000,
      responseObject: {},
      inputItems: [],
      modelAlias: 'm'
    })
    store.put({
      id: 'resp_3',
      createdAtSec: 3,
      expiresAtSec: 2_000_000_000,
      responseObject: {},
      inputItems: [],
      modelAlias: 'm'
    })
    assert.equal(store.get('resp_1'), undefined)
    assert.ok(store.get('resp_3'))
  })

  it('expires by ttl', () => {
    let t = 0
    const store = createResponsesStore({
      maxEntries: 10,
      ttlMs: 1000,
      now: (): number => { return t }
    })
    t = 0
    store.put({
      id: 'resp_e',
      createdAtSec: 0,
      expiresAtSec: 1,
      responseObject: {},
      inputItems: [],
      modelAlias: 'm'
    })
    t = 2000
    assert.equal(store.get('resp_e'), undefined)
  })

  it('listInputItems returns list shape', () => {
    const store = createResponsesStore({ maxEntries: 10, ttlMs: 60_000 })
    store.put({
      id: 'resp_l',
      createdAtSec: 1,
      expiresAtSec: 2_000_000_000,
      responseObject: {},
      inputItems: [
        { type: 'message', id: 'i1', role: 'user', content: [{ type: 'input_text', text: 'x' }] }
      ],
      modelAlias: 'm'
    })
    const page = store.listInputItems('resp_l', { limit: 10 })
    assert.ok(page)
    assert.equal(page!.object, 'list')
    assert.equal(page!.data.length, 1)
  })

  it('listInputItems paginates with after cursor and reports has_more correctly', () => {
    const store = createResponsesStore({ maxEntries: 10, ttlMs: 60_000 })
    const items = Array.from({ length: 5 }, (_, i) => ({
      type: 'message',
      id: `i${i + 1}`,
      role: 'user',
      content: [{ type: 'input_text', text: `t${i + 1}` }]
    }))
    store.put({
      id: 'resp_p',
      createdAtSec: 1,
      expiresAtSec: 2_000_000_000,
      responseObject: {},
      inputItems: items,
      modelAlias: 'm'
    })

    const page1 = store.listInputItems('resp_p', { limit: 2 })
    assert.ok(page1)
    assert.equal(page1!.data.length, 2)
    assert.equal(page1!.first_id, 'i1')
    assert.equal(page1!.last_id, 'i2')
    assert.equal(page1!.has_more, true)

    const page2 = store.listInputItems('resp_p', { limit: 2, after: page1!.last_id! })
    assert.ok(page2)
    assert.equal(page2!.data.length, 2)
    assert.equal(page2!.first_id, 'i3')
    assert.equal(page2!.last_id, 'i4')
    assert.equal(page2!.has_more, true)

    const page3 = store.listInputItems('resp_p', { limit: 2, after: page2!.last_id! })
    assert.ok(page3)
    assert.equal(page3!.data.length, 1)
    assert.equal(page3!.first_id, 'i5')
    assert.equal(page3!.has_more, false)
  })

  it('bannerLine mentions limits', () => {
    const store = createResponsesStore({ maxEntries: 128, ttlMs: 120_000 })
    assert.ok(store.bannerLine().includes('128'))
    assert.ok(store.bannerLine().includes('2m'))
  })
})
