import { createVectorIndex, loadVectorIndex } from '@qvac/sdk'
import type { IndexHandle, IndexProvider, IndexSearchResult } from '@qvac/rag'

type VectorIndex = Awaited<ReturnType<typeof createVectorIndex>>

const PADDING = 0xffffffffffffffffn

// @qvac/rag's index provider over the SDK's vector index, so rag on Node searches the
// worker's index instead of scanning. Calls on one SDK index run in call order, as rag needs.
export function sdkIndexProvider(): IndexProvider {
  function wrap(index: VectorIndex): IndexHandle {
    const { dim } = index
    return {
      get length() {
        return index.length
      },
      dim,
      async addWithIds(vectors, ids) {
        const rows: number[][] = []
        for (let i = 0; i < ids.length; i++) {
          rows.push(Array.from(vectors.subarray(i * dim, (i + 1) * dim)))
        }
        await index.add({ ids: Array.from(ids), vectors: rows })
      },
      async remove(id) {
        const [removed] = await index.remove({ ids: [id] })
        return removed === true
      },
      async contains(id) {
        const [present] = await index.contains({ ids: [id] })
        return present === true
      },
      async search(query, k): Promise<IndexSearchResult> {
        const hits = await index.search({ query: Array.from(query), k })
        const ids = new BigUint64Array(k).fill(PADDING)
        const scores = new Float32Array(k)
        hits.forEach((hit, i) => {
          ids[i] = BigInt(hit.id)
          scores[i] = hit.score
        })
        return { ids, scores, k }
      },
      async write(path) {
        await index.write({ path })
      },
      async dispose() {
        await index.dispose()
      }
    }
  }

  return {
    async create(dim, storage) {
      return wrap(await createVectorIndex({ dim, storage }))
    },
    async load(path) {
      return wrap(await loadVectorIndex({ path }))
    }
  }
}
