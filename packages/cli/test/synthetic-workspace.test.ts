import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { syntheticFromWorkspace } from '../src/serve/adapters/openai/routes/vector-stores.js'

describe('syntheticFromWorkspace', () => {
  const workspaces = [{ name: 'vs_known', open: false }]

  it('returns null when the workspace is not present', () => {
    assert.equal(syntheticFromWorkspace('vs_missing', workspaces), null)
  })

  it('uses a stable 0 anchor for createdAt and lastActiveAt (no wall-clock tick)', () => {
    const a = syntheticFromWorkspace('vs_known', workspaces)
    const b = syntheticFromWorkspace('vs_known', workspaces)
    assert.ok(a)
    assert.ok(b)
    assert.equal(a.createdAt, 0)
    assert.equal(a.lastActiveAt, 0)
    assert.equal(b.createdAt, 0)
    assert.equal(b.lastActiveAt, 0)
    // No drift between calls — the previous Date.now() implementation
    // would have shown different values here.
    assert.deepEqual(a, b)
  })

  it('keeps name = id and an empty metadata map', () => {
    const meta = syntheticFromWorkspace('vs_known', workspaces)
    assert.ok(meta)
    assert.equal(meta.id, 'vs_known')
    assert.equal(meta.name, 'vs_known')
    assert.deepEqual(meta.metadata, {})
    assert.equal(meta.expiresAfter, null)
    assert.equal(meta.expiresAt, null)
    assert.equal(meta.embeddingAlias, null)
  })
})
