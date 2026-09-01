// In-memory TurboVec index provider fixture. Tests exercise the TurboVec
// adapter path without a native addon; `calls` records provider usage so
// tests can assert the native index is actually consulted.
import fs from 'bare-fs'
import { z } from 'zod'
import type { TurboVecIndex, TurboVecIndexProvider } from '@qvac/rag'
import { registerPlugin } from '@/plugins'

export function observableIndexProvider() {
  const calls = { create: 0, load: 0, addWithIds: 0, search: 0 }

  function createIndex(dim: number): TurboVecIndex {
    const indexIds: bigint[] = []
    return {
      get length() {
        return indexIds.length
      },
      dim,
      addWithIds(_vectors, ids) {
        calls.addWithIds++
        for (const id of ids) indexIds.push(id)
      },
      search(_queries, k) {
        calls.search++
        const ids = indexIds.slice(0, k)
        return {
          scores: new Float32Array(ids.length).fill(1),
          ids: new BigUint64Array(ids),
          m: 1,
          k: ids.length
        }
      },
      contains(id) {
        return indexIds.includes(id)
      },
      remove(id) {
        const index = indexIds.indexOf(id)
        if (index === -1) return false
        indexIds.splice(index, 1)
        return true
      },
      prepare() {},
      write(snapshotPath) {
        fs.writeFileSync(snapshotPath, 'test index\n')
      },
      dispose() {}
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
