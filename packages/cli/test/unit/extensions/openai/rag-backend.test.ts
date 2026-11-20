import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createRagBackend,
  EmbeddingModelChangedError,
  VectorStoreInUseError,
  vectorStoreDirFor,
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

const model = {
  alias: 'embed',
  sdkModelId: 'model-1',
  model: 'gte-large.gguf',
  revision: 'abc123',
  config: '{"pooling":"mean"}'
}

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

  it('rejects a store whose alias now points at other weights or config', async () => {
    await withDir(async (dir) => {
      const backend = createRagBackend({ dir, embedTexts })
      await backend.attach('vs_d', model, {
        fileId: 'file-1',
        fileName: 'moon.txt',
        text: 'A moon in orbit.'
      })
      for (const swapped of [
        { ...model, revision: 'def456' },
        { ...model, config: '{"pooling":"cls"}' }
      ]) {
        await assert.rejects(backend.search('vs_d', swapped, 'moon', 1), EmbeddingModelChangedError)
        await assert.rejects(
          backend.attach('vs_d', swapped, { fileId: 'file-2', fileName: 'x.txt', text: 'orbit' }),
          EmbeddingModelChangedError
        )
      }
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

  it('lets two servers write different stores at the same time', async () => {
    await withDir(async (dir) => {
      const first = createRagBackend({ dir, embedTexts })
      const second = createRagBackend({ dir, embedTexts })
      await first.attach('vs_x', model, {
        fileId: 'file-1',
        fileName: 'moon.txt',
        text: 'A moon in orbit.'
      })
      await second.attach('vs_y', model, {
        fileId: 'file-2',
        fileName: 'oven.txt',
        text: 'Preheat the oven.'
      })
      assert.equal((await first.search('vs_x', model, 'moon', 1))[0]?.fileId, 'file-1')
      assert.equal((await second.search('vs_y', model, 'oven', 1))[0]?.fileId, 'file-2')
      await first.close()
      await second.close()
    })
  })

  it('removes the store data from disk on delete', async () => {
    await withDir(async (dir) => {
      const backend = createRagBackend({ dir, embedTexts })
      await backend.attach('vs_e', model, {
        fileId: 'file-1',
        fileName: 'moon.txt',
        text: 'A moon in orbit.'
      })
      assert.equal(await backend.delete('vs_e'), true)
      assert.deepEqual(await readdir(path.join(dir, 'stores')), [])
      await backend.close()
    })
  })

  it('refuses to delete a store another server has open', async () => {
    await withDir(async (dir) => {
      const first = createRagBackend({ dir, embedTexts })
      const second = createRagBackend({ dir, embedTexts })
      await first.attach('vs_h', model, {
        fileId: 'file-1',
        fileName: 'moon.txt',
        text: 'A moon in orbit.'
      })

      await assert.rejects(second.delete('vs_h'), VectorStoreInUseError)
      const hits = await first.search('vs_h', model, 'moon', 1)
      assert.equal(hits[0]?.fileId, 'file-1')

      await first.close()
      assert.equal(await second.delete('vs_h'), true)
      assert.deepEqual(await readdir(path.join(dir, 'stores')), [])
      await second.close()
    })
  })

  it('finishes a delete whose data could not be removed', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root ignores directory permissions')
    await withDir(async (dir) => {
      const backend = createRagBackend({ dir, embedTexts })
      await backend.attach('vs_g', model, {
        fileId: 'file-1',
        fileName: 'moon.txt',
        text: 'A moon in orbit.'
      })
      const storesDir = path.join(dir, 'stores')
      await chmod(path.join(storesDir, 'vs_g'), 0o500)
      await assert.rejects(backend.delete('vs_g'))

      const [leftover = '', ...others] = await readdir(storesDir)
      assert.ok(leftover.startsWith('.deleted-vs_g-'))
      assert.deepEqual(others, [])
      assert.deepEqual(await backend.list(), [])
      assert.deepEqual(await backend.search('vs_g', model, 'moon', 1), [])

      await chmod(path.join(storesDir, leftover), 0o700)
      assert.deepEqual(await backend.list(), [])
      assert.deepEqual(await readdir(storesDir), [])
      await backend.close()
    })
  })

  it('ingests nothing when the store record cannot be written', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root ignores directory permissions')
    await withDir(async (dir) => {
      const backend = createRagBackend({ dir, embedTexts })
      await backend.attach('vs_f', model, {
        fileId: 'file-1',
        fileName: 'moon.txt',
        text: 'A moon in orbit.'
      })
      const storeDir = path.join(dir, 'stores', 'vs_f')
      await chmod(storeDir, 0o500)
      try {
        await assert.rejects(
          backend.attach('vs_f', model, {
            fileId: 'file-2',
            fileName: 'oven.txt',
            text: 'Preheat the oven.'
          })
        )
      } finally {
        await chmod(storeDir, 0o700)
      }
      const hits = await backend.search('vs_f', model, 'oven moon orbit', 5)
      assert.deepEqual(
        hits.map((hit) => hit.fileId),
        ['file-1']
      )
      await backend.close()
    })
  })

  it('does not hold up other stores or reads while one store ingests', async () => {
    await withDir(async (dir) => {
      let release = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const slow: EmbedTexts = async (modelId, texts) => {
        if (texts.some((text) => text.includes('river'))) await held
        return embedTexts(modelId, texts)
      }
      const backend = createRagBackend({ dir, embedTexts: slow })
      await backend.attach('vs_g', model, {
        fileId: 'file-1',
        fileName: 'moon.txt',
        text: 'A moon in orbit.'
      })
      const ingesting = backend.attach('vs_h', model, {
        fileId: 'file-2',
        fileName: 'river.txt',
        text: 'The bridge crosses the river.'
      })
      assert.ok((await backend.list()).includes('vs_g'))
      assert.equal(await backend.embeddingAlias('vs_g'), 'embed')
      assert.equal((await backend.search('vs_g', model, 'moon', 1))[0]?.fileId, 'file-1')
      release()
      await ingesting
      await backend.close()
    })
  })

  it('keeps vector stores next to the configured model cache', () => {
    assert.equal(
      vectorStoreDirFor('/data/qvac/models'),
      path.join('/data/qvac', 'serve', 'vector-stores')
    )
  })
})
