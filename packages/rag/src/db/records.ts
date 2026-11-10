// Row shapes of the collections in hyperspec, see scripts/build-hyperdb-spec.ts.

export const SPACES = '@rag/spaces'
export const NAMESPACES = '@rag/namespaces'
export const DOCUMENTS = '@rag/documents'
export const CHUNKS = '@rag/chunks'
export const NATIVE_IDS = '@rag/nativeIds'
export const MUTATIONS = '@rag/mutations'

export interface SpaceRecord {
  spaceId: string
  model: string
  revision: string
  dimensions: number
  metric: string
  normalized: boolean
  documentEncoding: string
  queryEncoding: string
  preprocessing: string
}

export interface NamespaceRecord {
  name: string
  spaceId: string
  revision: number
  nextNativeId: Uint8Array
  createdAt: Date
}

export interface DocumentRecord {
  namespace: string
  documentId: string
  generation: number
  chunkCount: number
  contentHash: string
  metadata?: Record<string, unknown>
  updatedAt: Date
}

export interface ChunkRecord {
  namespace: string
  documentId: string
  generation: number
  ordinal: number
  chunkId: string
  content: string
  metadataJson?: string
  nativeId: Uint8Array
  vector: Uint8Array
}

export interface NativeIdRecord {
  namespace: string
  nativeId: Uint8Array
  documentId: string
  generation: number
  ordinal: number
}

export interface MutationRecord {
  namespace: string
  revision: number
  added: Uint8Array
  removed: Uint8Array
  createdAt: Date
}
