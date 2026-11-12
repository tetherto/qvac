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
