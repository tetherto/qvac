export interface ChunkAttribution {
  fileId: string
  fileName: string
}

export interface ChunkAttributionStore {
  /**
   * Record attribution for a chunk under a specific vector store. Later
   * `lookup(vectorStoreId, chunkId)` calls will return this attribution so
   * `searchResultsToOpenAI` can map RAG chunks back to the original upload's
   * `file_id` and `filename`.
   */
  record: (vectorStoreId: string, chunkId: string, attribution: ChunkAttribution) => void
  /** Look up attribution. Returns null when the chunk has no recorded source (eg. ingested before the current process). */
  lookup: (vectorStoreId: string, chunkId: string) => ChunkAttribution | null
  /** Drop all attributions for a vector store; called on DELETE so the map cannot leak across the store's lifetime. */
  evict: (vectorStoreId: string) => void
}

export function createChunkAttributionStore(): ChunkAttributionStore {
  const map = new Map<string, Map<string, ChunkAttribution>>()

  return {
    record(vectorStoreId, chunkId, attribution) {
      let inner = map.get(vectorStoreId)
      if (!inner) {
        inner = new Map()
        map.set(vectorStoreId, inner)
      }
      inner.set(chunkId, { fileId: attribution.fileId, fileName: attribution.fileName })
    },
    lookup(vectorStoreId, chunkId) {
      const inner = map.get(vectorStoreId)
      const found = inner?.get(chunkId)
      return found ? { fileId: found.fileId, fileName: found.fileName } : null
    },
    evict(vectorStoreId) {
      map.delete(vectorStoreId)
    }
  }
}
