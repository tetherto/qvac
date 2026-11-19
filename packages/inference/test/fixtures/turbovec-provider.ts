// In-memory TurboVec index provider fixture. Tests exercise the TurboVec
// adapter path without a native addon; `calls` records provider usage so
// tests can assert the native index is actually consulted.
import fs from 'bare-fs'
import { z } from 'zod'
import type {
  TurboVecIndexProvider,
  TurboVecIndexSearchResult as SearchResult
} from '@/plugins/turbovec-index'
import { registerPlugin } from '@/plugins'
import type { IndexWithControls } from '@/plugins/turbovec-backend'

type FakeIndex = IndexWithControls & {
  // Mirrors the real IdMapIndex getter that a loaded snapshot exposes; the
  // TurboVecIndex interface itself does not declare it.
  bitWidth?: number
}

/**
 * With `ivf: true`, `searchIvf` throws on stale lists as the native index
 * does, so tests catch an adapter that probes them. Index methods return
 * promises as `@qvac/turbovec-ggml` 0.7 does; `sync: true` returns values
 * directly, as 0.5 does.
 */
export function observableIndexProvider({
  ivf = false,
  sync = false
}: { ivf?: boolean; sync?: boolean } = {}) {
  const calls = {
    create: 0,
    load: 0,
    addWithIds: 0,
    search: 0,
    remove: 0,
    contains: 0,
    prepare: 0,
    write: 0,
    dispose: 0,
    buildIvf: 0,
    searchIvf: 0
  }

  const lastIvfArgs: { nLists?: number; nIter?: number | undefined; nProbe?: number } = {}

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
    dispose: false,
    buildIvf: false
  }

  // `remove` is the one batched call, so its switch names a single id rather
  // than the whole batch; that is what exposes partial application.
  const failRemoveId: { id: bigint | null } = { id: null }

  // Promises an open waits on before it returns, so a test can act while the
  // native open is in flight.
  const gates: { create: Promise<void> | null; load: Promise<void> | null } = {
    create: null,
    load: null
  }

  function fail(call: string): never {
    throw new Error(`native ${call} failed`)
  }

  function createIndex(dim: number, bitWidth?: number): FakeIndex {
    const indexIds: bigint[] = []
    let ivfBuilt = false
    const index: FakeIndex = {
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
        ivfBuilt = false
      },
      search(queries, k) {
        calls.search++
        if (failures.search) fail('search')
        return paddedRows(queries, k)
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
        ivfBuilt = false
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

    // Pads short rows with UINT64_MAX and a very negative score, as the
    // native index does.
    function paddedRows(queries: Float32Array, k: number): SearchResult {
      const m = queries.length / dim
      const ids = indexIds.slice(0, k)
      const paddedIds = new BigUint64Array(m * k).fill(0xffffffffffffffffn)
      const scores = new Float32Array(m * k).fill(-3.4e38)
      for (let row = 0; row < m; row++) {
        paddedIds.set(ids, row * k)
        scores.fill(1, row * k, row * k + ids.length)
      }
      return { scores, ids: paddedIds, m, k }
    }

    if (ivf) {
      index.buildIvf = (nLists, nIter) => {
        calls.buildIvf++
        if (failures.buildIvf) fail('buildIvf')
        lastIvfArgs.nLists = nLists
        lastIvfArgs.nIter = nIter
        ivfBuilt = true
      }
      index.searchIvf = (queries, k, nProbe) => {
        calls.searchIvf++
        lastIvfArgs.nProbe = nProbe
        if (!ivfBuilt) throw new Error('InvalidArgument')
        return paddedRows(queries, k)
      }
    }
    return sync ? index : asAsync(index)
  }

  const provider: TurboVecIndexProvider = {
    async create(options) {
      calls.create++
      if (failures.create) fail('create')
      if (gates.create) await gates.create
      return createIndex(options.dim)
    },
    async load() {
      calls.load++
      if (failures.load) fail('load')
      if (gates.load) await gates.load
      return createIndex(8, 8)
    }
  }
  return { provider, calls, failures, failRemoveId, lastIvfArgs, gates }
}

const INDEX_METHODS = [
  'addWithIds',
  'search',
  'contains',
  'remove',
  'prepare',
  'write',
  'dispose',
  'buildIvf',
  'searchIvf'
] as const

// Each call settles after a microtask, so a caller that forgets to await sees
// a pending promise instead of the result, and native failures reject.
function asAsync(index: FakeIndex): FakeIndex {
  const methods = index as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>
  for (const name of INDEX_METHODS) {
    const method = methods[name]
    if (!method) continue
    methods[name] = async (...args: unknown[]) => {
      await Promise.resolve()
      return method.apply(index, args)
    }
  }
  return index
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
