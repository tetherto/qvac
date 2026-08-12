import { QvacErrorRAG, ERR_CODES } from '../errors.js'
import type { Doc, PartialDoc } from '../types.js'
import qvacCrypto from '#crypto'

const UUID_BYTES = 16
const BYTE_TO_HEX = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1))

// Calculate the cosine similarity between two vectors.
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] ** 2
    normB += b[i] ** 2
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// Calculate the lexical score between a query and a content string.
export function calculateTextScore(query: string, content: string): number {
  const queryTerms = query.toLowerCase().split(/\s+/)
  const contentLower = content.toLowerCase()
  const exactMatches = queryTerms.filter((term) => contentLower.includes(term)).length
  const contentTerms = contentLower.split(/\s+/)
  const positions = queryTerms.reduce((map, term) => {
    const pos = contentTerms.indexOf(term)
    if (pos !== -1) map.set(term, pos)
    return map
  }, new Map<string, number>())
  let proximityScore = 0
  if (positions.size > 1) {
    const posArray = Array.from(positions.values())
    const spread = Math.max(...posArray) - Math.min(...posArray)
    proximityScore = 1 / (1 + spread / 10)
  }
  return (exactMatches / queryTerms.length) * 0.7 + proximityScore * 0.3
}

// Normalizes the documents input to an array of documents, wrapping bare
// strings as { content }. Returns the normalized docs and the dropped indices.
export function normalizeDocs(docs: Array<string | PartialDoc>): {
  normalizedDocs: Doc[]
  droppedIndices: number[]
} {
  if (!Array.isArray(docs)) throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT })

  const seenIds = new Set<string>()
  const normalizedDocs: Doc[] = []
  const droppedIndices: number[] = []

  docs.forEach((rawDoc, idx) => {
    const doc: PartialDoc = typeof rawDoc === 'string' ? { content: rawDoc } : rawDoc
    if (!doc || !doc.content || (typeof doc.content === 'string' && doc.content.trim() === '')) {
      droppedIndices.push(idx)
      return
    }
    const id = doc.id || generateId()
    if (seenIds.has(id)) {
      throw new QvacErrorRAG({ code: ERR_CODES.DUPLICATE_DOCUMENT_ID, adds: [id] })
    }
    seenIds.add(id)
    normalizedDocs.push({ ...doc, id })
  })
  return {
    normalizedDocs,
    droppedIndices
  }
}

// Generates a unique ID using UUID v4.
export function generateId(): string {
  const bytes = randomBytes(UUID_BYTES)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  return (
    BYTE_TO_HEX[bytes[0]] +
    BYTE_TO_HEX[bytes[1]] +
    BYTE_TO_HEX[bytes[2]] +
    BYTE_TO_HEX[bytes[3]] +
    '-' +
    BYTE_TO_HEX[bytes[4]] +
    BYTE_TO_HEX[bytes[5]] +
    '-' +
    BYTE_TO_HEX[bytes[6]] +
    BYTE_TO_HEX[bytes[7]] +
    '-' +
    BYTE_TO_HEX[bytes[8]] +
    BYTE_TO_HEX[bytes[9]] +
    '-' +
    BYTE_TO_HEX[bytes[10]] +
    BYTE_TO_HEX[bytes[11]] +
    BYTE_TO_HEX[bytes[12]] +
    BYTE_TO_HEX[bytes[13]] +
    BYTE_TO_HEX[bytes[14]] +
    BYTE_TO_HEX[bytes[15]]
  )
}

function randomBytes(size: number): Uint8Array {
  try {
    const crypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
      .crypto
    if (crypto && typeof crypto.getRandomValues === 'function') {
      return crypto.getRandomValues(new Uint8Array(size))
    }
  } catch {}

  try {
    if (qvacCrypto && typeof qvacCrypto.randomBytes === 'function') {
      return toUint8Array(qvacCrypto.randomBytes(size))
    }
    if (qvacCrypto && typeof qvacCrypto.getRandomValues === 'function') {
      return qvacCrypto.getRandomValues(new Uint8Array(size))
    }
  } catch {}

  throw new QvacErrorRAG({
    code: ERR_CODES.DEPENDENCY_REQUIRED,
    adds: 'No secure random byte source available for UUID generation. Provide globalThis.crypto.getRandomValues or a #crypto implementation with randomBytes/getRandomValues.'
  })
}

function toUint8Array(bytes: Uint8Array | ArrayBuffer | ArrayBufferView | number[]): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes
  if (typeof ArrayBuffer !== 'undefined' && bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes)
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  return Uint8Array.from(bytes as number[])
}

// Maintain min-heap property when adding elements.
export function heapifyUp<T extends { similarity: number }>(heap: T[], index: number): void {
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2)
    if (heap[parentIndex].similarity <= heap[index].similarity) break
    ;[heap[parentIndex], heap[index]] = [heap[index], heap[parentIndex]]
    index = parentIndex
  }
}

// Maintain min-heap property when removing elements.
export function heapifyDown<T extends { similarity: number }>(heap: T[], index: number): void {
  const heapSize = heap.length

  while (true) {
    let smallest = index
    const leftChild = 2 * index + 1
    const rightChild = 2 * index + 2
    if (leftChild < heapSize && heap[leftChild].similarity < heap[smallest].similarity) {
      smallest = leftChild
    }
    if (rightChild < heapSize && heap[rightChild].similarity < heap[smallest].similarity) {
      smallest = rightChild
    }
    if (smallest === index) break
    ;[heap[index], heap[smallest]] = [heap[smallest], heap[index]]
    index = smallest
  }
}

// Reservoir sampling for efficient random sampling of `sampleSize` items.
export function reservoirSample<T>(array: T[], sampleSize: number): T[] {
  if (sampleSize >= array.length) {
    return array.slice()
  }
  const sample = array.slice(0, sampleSize)
  for (let i = sampleSize; i < array.length; i++) {
    const randomIndex = Math.floor(Math.random() * (i + 1))
    if (randomIndex < sampleSize) {
      sample[randomIndex] = array[i]
    }
  }
  return sample
}

export interface LRUCache<K, V> {
  get(key: K): V | undefined
  set(key: K, value: V): void
  has(key: K): boolean
  delete(key: K): boolean
  clear(): void
  readonly size: number
}

// Creates an LRU (Least Recently Used) cache bounded to `maxSize` entries.
export function createLRUCache<K, V>(maxSize: number): LRUCache<K, V> {
  const cache = new Map<K, V>()

  return {
    get(key) {
      if (!cache.has(key)) return undefined
      // Move to end (most recently used)
      const value = cache.get(key)
      cache.delete(key)
      cache.set(key, value as V)
      return value
    },

    set(key, value) {
      // If key exists, delete first to update position
      if (cache.has(key)) {
        cache.delete(key)
      }
      cache.set(key, value)
      // Evict LRU (first entry) if over capacity
      if (cache.size > maxSize) {
        const lruKey = cache.keys().next().value
        if (lruKey !== undefined) cache.delete(lruKey)
      }
    },

    has(key) {
      return cache.has(key)
    },

    delete(key) {
      return cache.delete(key)
    },

    clear() {
      cache.clear()
    },

    get size() {
      return cache.size
    }
  }
}
