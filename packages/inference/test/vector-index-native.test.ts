import test from 'brittle'
import env from 'bare-env'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { clearPlugins } from '@/plugins'
import { close } from '@/dispatch'
import { createVectorIndex, loadVectorIndex } from '@/api/vector-index'
import { disposeAllVectorIndexes } from '@/runtime/vector-index-registry'
import { VectorIndexFailedError } from '@/errors/index'
import { registerProviderPlugin } from './fixtures/turbovec-provider'

// Keep the storage-root lock out of the real home, as dispatch.test.ts does.
env['HOME'] = path.join(os.tmpdir(), `qvac-inference-native-test-${os.pid()}`)

// The addon suite owns calibration, staged search, and dimension rules. This
// file only checks that the adapter reads the addon's controls by the names it
// expects and that the handle carries their state through a snapshot. It lives
// apart from vector-index.test.ts so a missing addon fails only this file.
test('vector index: native controls round trip through the adapter', async (t) => {
  const { IdMapIndex } = await import('@qvac/turbovec-ggml')
  clearPlugins()
  registerProviderPlugin('test-native-vector-index', {
    create: (options) => new IdMapIndex(options),
    load: (snapshotPath) => IdMapIndex.load(snapshotPath)
  })
  const snapshotPath = path.join(os.tmpdir(), `qvac-vector-index-native-${os.pid()}.qvi`)
  // Seeded Gaussian rows, so the first add is large enough to calibrate.
  let seed = 42
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return (seed + 1) / 4294967297
  }
  const vectors = Array.from({ length: 1000 }, () =>
    Array.from(
      { length: 32 },
      () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random())
    )
  )
  const ids = vectors.map((_row, i) => String(i))
  try {
    const index = await createVectorIndex({ dim: 32, storage: 'turbovec-q4' })
    t.is(index.calibrated, false)
    t.is(index.stagedSearch, false)
    await index.add({ ids, vectors })
    t.is(index.calibrated, true, 'add reports calibration')
    await index.setStagedSearch({ enabled: true })
    t.is(index.stagedSearch, true)
    await index.write({ path: snapshotPath })
    const loaded = await loadVectorIndex({ path: snapshotPath })
    t.is(loaded.calibrated, true, 'load reports calibration')
    t.is(loaded.stagedSearch, false, 'load reports the reset setting')

    const generic = await createVectorIndex({ dim: 8, storage: 'q8' })
    try {
      await generic.setStagedSearch({ enabled: true })
      t.fail('generic storage should reject staged search')
    } catch (error) {
      t.ok(error instanceof VectorIndexFailedError, 'the native rejection maps to a coded error')
    }
    t.is(generic.stagedSearch, false)
  } finally {
    fs.rmSync(snapshotPath, { force: true })
    await disposeAllVectorIndexes()
    await close()
    clearPlugins()
  }
})

test('vector index: native IVF settings round trip through the adapter', async (t) => {
  const { IdMapIndex } = await import('@qvac/turbovec-ggml')
  clearPlugins()
  registerProviderPlugin('test-native-vector-index-ivf', {
    create: (options) => new IdMapIndex(options),
    load: (snapshotPath) => IdMapIndex.load(snapshotPath)
  })
  let seed = 7
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296 - 0.5
  }
  const vectors = Array.from({ length: 256 }, () => Array.from({ length: 32 }, random))
  const ids = vectors.map((_row, i) => String(i))
  const queries = [vectors[3]!, vectors[200]!]
  const idsOf = (rows: { id: string }[][]) => rows.map((row) => row.map((hit) => hit.id))
  try {
    for (const storage of ['f32', 'turbovec-q4'] as const) {
      const index = await createVectorIndex({ dim: 32, storage })
      t.is(index.ivf, null, `${storage}: IVF starts off`)
      await index.add({ ids, vectors })
      const full = await index.search({ queries, k: 5 })
      try {
        await index.search({ query: vectors[3]!, k: 5, nProbe: 1 })
        t.fail(`${storage}: nProbe without IVF should reject`)
      } catch (error) {
        t.ok(
          error instanceof VectorIndexFailedError,
          `${storage}: nProbe without IVF is a coded error`
        )
      }

      await index.setIvf({ nLists: 8, nProbe: 8 })
      t.alike(index.ivf, { nLists: 8, nProbe: 8, built: true })
      t.alike(
        idsOf(await index.search({ queries, k: 5 })),
        idsOf(full),
        `${storage}: probing every list matches the full search`
      )
      const [nearest] = await index.search({ query: vectors[3]!, k: 1, nProbe: 2 })
      t.is(nearest?.id, '3', `${storage}: a stored vector finds itself`)

      await index.add({ ids: ['1000'], vectors: [vectors[0]!] })
      t.is(index.ivf?.built, false, `${storage}: an add discards the IVF lists`)
      const [fallback] = await index.search({ query: vectors[3]!, k: 1 })
      t.is(fallback?.id, '3', `${storage}: stale IVF state falls back to the full scan`)

      await index.setIvf({ nLists: 8, nProbe: 8 })
      const [rebuilt] = await index.search({ query: vectors[3]!, k: 1 })
      t.is(rebuilt?.id, '3', `${storage}: search probes the rebuilt lists`)
      await index.dispose()
    }
  } finally {
    await disposeAllVectorIndexes()
    await close()
    clearPlugins()
  }
})

test('vector index: native IVF builds with fewer entries than lists', async (t) => {
  const { IdMapIndex } = await import('@qvac/turbovec-ggml')
  clearPlugins()
  registerProviderPlugin('test-native-vector-index-ivf-small', {
    create: (options) => new IdMapIndex(options),
    load: (snapshotPath) => IdMapIndex.load(snapshotPath)
  })
  let seed = 11
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296 - 0.5
  }
  const vectors = Array.from({ length: 5 }, () => Array.from({ length: 32 }, random))
  const ids = vectors.map((_row, i) => String(i))
  const idsOf = (rows: { id: string }[]) => rows.map((hit) => hit.id)
  try {
    for (const storage of ['f32', 'turbovec-q4'] as const) {
      const empty = await createVectorIndex({ dim: 32, storage })
      await empty.setIvf({ nLists: 8, nProbe: 2 })
      t.is(empty.ivf?.built, true, `${storage}: an empty index builds`)
      t.alike(
        await empty.search({ queries: [vectors[0]!], k: 3 }),
        [[]],
        `${storage}: searching the empty lists finds nothing`
      )
      await empty.dispose()

      // Native caps the list count at the entry count.
      const index = await createVectorIndex({ dim: 32, storage })
      await index.add({ ids, vectors })
      const full = await index.search({ query: vectors[2]!, k: 10 })
      await index.setIvf({ nLists: 8, nProbe: 8 })
      t.is(index.ivf?.built, true, `${storage}: more lists than entries builds`)
      t.alike(
        idsOf(await index.search({ query: vectors[2]!, k: 10 })),
        idsOf(full),
        `${storage}: probing every list returns every entry`
      )
      await index.dispose()
    }
  } finally {
    await disposeAllVectorIndexes()
    await close()
    clearPlugins()
  }
})
