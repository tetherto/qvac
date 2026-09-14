// In-memory TurboVec index provider fixture. Tests exercise the TurboVec
// adapter path without a native addon; `calls` records provider usage so
// tests can assert the native index is actually consulted.
import fs from 'bare-fs'
import { z } from 'zod'
import type { TurboVecIndex, TurboVecIndexProvider } from '@qvac/rag'
import { registerPlugin } from '@/plugins'

export function observableIndexProvider() {
  const calls = {
    create: 0,
    load: 0,
    addWithIds: 0,
    search: 0,
    remove: 0,
    contains: 0,
    prepare: 0,
    write: 0,
    dispose: 0
  }

  function createIndex(dim: number): TurboVecIndex {
    const indexIds: bigint[] = []
    return {
      get length() {
        return indexIds.length
      },
      dim,
      addWithIds(_vectors, ids) {
        calls.addWithIds++
        for (const id of ids) {
          if (indexIds.includes(id)) throw new Error(`duplicate id ${id}`)
        }
        for (const id of ids) indexIds.push(id)
      },
      // Pads short rows with UINT64_MAX and a very negative score, as the
      // native index does.
      search(_queries, k) {
        calls.search++
        const ids = indexIds.slice(0, k)
        const paddedIds = new BigUint64Array(k).fill(0xffffffffffffffffn)
        paddedIds.set(ids)
        const scores = new Float32Array(k).fill(-3.4e38)
        scores.fill(1, 0, ids.length)
        return { scores, ids: paddedIds, m: 1, k }
      },
      contains(id) {
        calls.contains++
        return indexIds.includes(id)
      },
      remove(id) {
        calls.remove++
        const index = indexIds.indexOf(id)
        if (index === -1) return false
        indexIds.splice(index, 1)
        return true
      },
      prepare() {
        calls.prepare++
      },
      write(snapshotPath) {
        calls.write++
        fs.writeFileSync(snapshotPath, 'test index\n')
      },
      dispose() {
        calls.dispose++
      }
    }
  }

  const provider: TurboVecIndexProvider = {
    create(options) {
      calls.create++
      return createIndex(options.dim)
    },
    load() {
      calls.load++
      return createIndex(8)
    }
  }
  return { provider, calls }
}

export function registerProviderPlugin(modelType: string, provider: TurboVecIndexProvider) {
  registerPlugin({
    modelType,
    displayName: modelType,
    addonPackage: '@qvac/test-addon',
    loadConfigSchema: z.object({}),
    createModel() {
      return {
        model: { load: async function () {} }
      }
    },
    handlers: {},
    capabilities: {
      turbovecIndexProvider: provider
    }
  })
}
