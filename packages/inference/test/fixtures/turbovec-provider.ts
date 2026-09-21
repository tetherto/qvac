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

  // Forced native failures, one switch per backend call. A test flips one to
  // assert what the registry does when that call throws; success-path
  // assertions cannot tell a correct ordering from an inverted one.
  const failures = {
    create: false,
    load: false,
    addWithIds: false,
    search: false,
    contains: false,
    remove: false,
    prepare: false,
    write: false,
    dispose: false
  }

  // `remove` is the one batched call, so its switch names a single id rather
  // than the whole batch; that is what exposes partial application.
  const failRemoveId: { id: bigint | null } = { id: null }

  function fail(call: string): never {
    throw new Error(`native ${call} failed`)
  }

  // `bitWidth` mirrors the real IdMapIndex getter that a loaded snapshot
  // exposes; the TurboVecIndex interface itself does not declare it.
  function createIndex(dim: number, bitWidth?: number): TurboVecIndex & { bitWidth?: number } {
    const indexIds: bigint[] = []
    return {
      get length() {
        return indexIds.length
      },
      dim,
      ...(bitWidth !== undefined && { bitWidth }),
      addWithIds(_vectors, ids) {
        calls.addWithIds++
        if (failures.addWithIds) fail('addWithIds')
        for (const id of ids) {
          if (indexIds.includes(id)) throw new Error(`duplicate id ${id}`)
        }
        for (const id of ids) indexIds.push(id)
      },
      // Pads short rows with UINT64_MAX and a very negative score, as the
      // native index does.
      search(_queries, k) {
        calls.search++
        if (failures.search) fail('search')
        const ids = indexIds.slice(0, k)
        const paddedIds = new BigUint64Array(k).fill(0xffffffffffffffffn)
        paddedIds.set(ids)
        const scores = new Float32Array(k).fill(-3.4e38)
        scores.fill(1, 0, ids.length)
        return { scores, ids: paddedIds, m: 1, k }
      },
      contains(id) {
        calls.contains++
        if (failures.contains) fail('contains')
        return indexIds.includes(id)
      },
      remove(id) {
        calls.remove++
        if (failures.remove || failRemoveId.id === id) fail('remove')
        const index = indexIds.indexOf(id)
        if (index === -1) return false
        indexIds.splice(index, 1)
        return true
      },
      prepare() {
        calls.prepare++
        if (failures.prepare) fail('prepare')
      },
      write(snapshotPath) {
        calls.write++
        if (failures.write) fail('write')
        fs.writeFileSync(snapshotPath, 'test index\n')
      },
      dispose() {
        calls.dispose++
        if (failures.dispose) throw new Error('native dispose failed')
      }
    }
  }

  const provider: TurboVecIndexProvider = {
    create(options) {
      calls.create++
      if (failures.create) fail('create')
      return createIndex(options.dim)
    },
    load() {
      calls.load++
      if (failures.load) fail('load')
      return createIndex(8, 8)
    }
  }
  return { provider, calls, failures, failRemoveId }
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
