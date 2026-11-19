import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createRagBackend,
  EmbeddingModelChangedError,
  type EmbedTexts
} from '@/serve/extensions/openai/adapters/rag-backend'

const WORDS = ['planet', 'moon', 'orbit', 'recipe', 'flour', 'oven', 'river', 'bridge']

// Counts known words, so texts sharing words score higher than unrelated ones.
const embedTexts: EmbedTexts = (_modelId, texts) =>
  Promise.resolve(
    texts.map((text) => {
      const lower = text.toLowerCase()
      return WORDS.map((word) => (lower.includes(word) ? 1 : 0) + 0.01)
    })
  )

const model = { alias: 'embed', sdkModelId: 'model-1', model: 'gte-large.gguf', revision: 'abc123' }

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qvac-cli-rag-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('createRagBackend', () => {
  it('attaches files, searches them by file and keeps them across restarts', async () => {
    await withDir(async (dir) => {
      const backend = createRagBackend({ dir, embedTexts })
      assert.deepEqual(await backend.list(), [])

      await backend.attach('vs_a', model, {
        fileId: 'file-space',
        fileName: 'space.txt',
        text: 'The planet has one moon in a slow orbit.'
      })
      await backend.attach('vs_a', model, {
        fileId: 'file-bread',
        fileName: 'bread.txt',
        text: 'Mix the flour and bake the recipe in the oven.'
      })

      const hits = await backend.search('vs_a', model, 'which moon orbits the planet?', 2)
      assert.equal(hits[0]?.fileId, 'file-space')
      assert.equal(hits[0]?.fileName, 'space.txt')
      assert.match(hits[0]?.content ?? '', /moon/)
      assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0))
      await backend.close()

      const reopened = createRagBackend({ dir, embedTexts })
      assert.deepEqual(await reopened.list(), ['vs_a'])
      assert.equal(await reopened.embeddingAlias('vs_a'), 'embed')
      const again = await reopened.search('vs_a', model, 'flour for the oven', 1)
      assert.equal(again[0]?.fileId, 'file-bread')
      await reopened.close()
    })
  })

  it('deletes a store and lets the same id start empty', async () => {
    await withDir(async (dir) => {
      const backend = createRagBackend({ dir, embedTexts })
      await backend.attach('vs_b', model, {
        fileId: 'file-1',
        fileName: 'river.txt',
        text: 'The bridge crosses the river.'
      })
      assert.equal(await backend.delete('vs_b'), true)
      assert.equal(await backend.delete('vs_b'), false)
      assert.deepEqual(await backend.list(), [])
      assert.deepEqual(await backend.search('vs_b', model, 'bridge', 3), [])

      await backend.attach('vs_b', model, {
        fileId: 'file-2',
        fileName: 'moon.txt',
        text: 'A moon in orbit.'
      })
      const hits = await backend.search('vs_b', model, 'river bridge moon', 5)
      assert.deepEqual(
        hits.map((hit) => hit.fileId),
        ['file-2'],
        'the deleted file does not come back'
      )
      await backend.close()
    })
  })

  it('deletes a store when its embedding model is not loaded', async () => {
    await withDir(async (dir) => {
      const first = createRagBackend({ dir, embedTexts })
      await first.attach('vs_c', model, {
        fileId: 'file-1',
        fileName: 'oven.txt',
        text: 'Preheat the oven.'
      })
      await first.close()

      const failing: EmbedTexts = () => Promise.reject(new Error('model not loaded'))
      const second = createRagBackend({ dir, embedTexts: failing })
      assert.equal(await second.delete('vs_c'), true)
      assert.deepEqual(await second.list(), [])
      await second.close()
    })
  })

  it('rejects a store whose alias now points at other weights', async () => {
    await withDir(async (dir) => {
      const backend = createRagBackend({ dir, embedTexts })
      await backend.attach('vs_d', model, {
        fileId: 'file-1',
        fileName: 'moon.txt',
        text: 'A moon in orbit.'
      })
      const swapped = { ...model, revision: 'def456' }
      await assert.rejects(backend.search('vs_d', swapped, 'moon', 1), EmbeddingModelChangedError)
      await assert.rejects(
        backend.attach('vs_d', swapped, { fileId: 'file-2', fileName: 'x.txt', text: 'orbit' }),
        EmbeddingModelChangedError
      )
      await backend.close()
    })
  })

  it('keeps stores written by another server on the same directory', async () => {
    await withDir(async (dir) => {
      const first = createRagBackend({ dir, embedTexts })
      const second = createRagBackend({ dir, embedTexts })
      assert.deepEqual(await first.list(), [])
      assert.deepEqual(await second.list(), [])
      await first.attach('vs_one', model, {
        fileId: 'file-1',
        fileName: 'moon.txt',
        text: 'A moon in orbit.'
      })
      await first.close()
      await second.attach('vs_two', model, {
        fileId: 'file-2',
        fileName: 'oven.txt',
        text: 'Preheat the oven.'
      })
      await second.close()
      const reopened = createRagBackend({ dir, embedTexts })
      assert.deepEqual((await reopened.list()).sort(), ['vs_one', 'vs_two'])
      await reopened.close()
    })
  })

  it('lets two aliases for the same weights stay open side by side', async () => {
    await withDir(async (dir) => {
      const first = createRagBackend({ dir, embedTexts })
      const second = createRagBackend({ dir, embedTexts })
      await first.attach('vs_x', model, {
        fileId: 'file-1',
        fileName: 'moon.txt',
        text: 'A moon in orbit.'
      })
      const other = { ...model, alias: 'embed-copy' }
      await second.attach('vs_y', other, {
        fileId: 'file-2',
        fileName: 'oven.txt',
        text: 'Preheat the oven.'
      })
      assert.equal((await first.search('vs_x', model, 'moon', 1))[0]?.fileId, 'file-1')
      assert.equal((await second.search('vs_y', other, 'oven', 1))[0]?.fileId, 'file-2')
      await first.close()
      await second.close()
    })
  })
})
