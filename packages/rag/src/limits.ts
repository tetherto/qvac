import { z } from 'zod'

// Hypercore refuses blocks over 15 MiB and HyperDB stores a row, with its key,
// in one block; this leaves room for the key, index nodes and encoding.
export const MAX_ROW_BYTES = 8 * 1024 * 1024

// Imported generations stay far below 2^53, so ingest can always add one.
export const MAX_GENERATION = 2 ** 32

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

// A lone surrogate is stored as U+FFFD, so it would hash and compare as one
// string but read back as another.
export function isWellFormed(value: string): boolean {
  return !LONE_SURROGATE.test(value)
}

const NOT_WELL_FORMED = 'must not contain lone UTF-16 surrogates'

export const text = z.string().refine(isWellFormed, NOT_WELL_FORMED)
export const name = z.string().min(1).refine(isWellFormed, NOT_WELL_FORMED)
export const optionalJson = z.string().min(1).refine(isWellFormed, NOT_WELL_FORMED).optional()

export function utf8Length(value: string): number {
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

// JSON.parse makes `__proto__` an own key, which validation and the stored
// copy would drop. Checked on the raw input, before Zod.
export function hasProtoKey(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, '__proto__')
}

// Returns why `value`, parsed JSON metadata, can't be stored as is, or null.
export function metadataProblem(value: unknown, path = 'metadata'): string | null {
  if (typeof value === 'string') {
    return isWellFormed(value) ? null : `${path} ${NOT_WELL_FORMED}`
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = metadataProblem(value[i], `${path}.${i}`)
      if (problem) return problem
    }
    return null
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === '__proto__') return `${path} has a '__proto__' key`
      if (!isWellFormed(key)) return `${path} has a key that ${NOT_WELL_FORMED}`
      const problem = metadataProblem(entry, `${path}.${key}`)
      if (problem) return problem
    }
  }
  return null
}

export interface RowChunk {
  id: string
  content: string
  metadataJson?: string
}

// Returns why one of the document's rows would be over MAX_ROW_BYTES, or null.
export function rowSizeProblem(
  namespace: string,
  documentId: string,
  metadata: Record<string, unknown> | undefined,
  chunks: RowChunk[],
  dimensions: number
): string | null {
  const keyBytes = utf8Length(namespace) + utf8Length(documentId)
  if (metadata !== undefined) {
    const bytes = keyBytes + utf8Length(JSON.stringify(metadata))
    if (bytes > MAX_ROW_BYTES) {
      return `document '${documentId}' metadata is ${bytes} bytes, over the ${MAX_ROW_BYTES} byte row limit`
    }
  }
  for (const chunk of chunks) {
    const bytes =
      keyBytes +
      utf8Length(chunk.id) +
      utf8Length(chunk.content) +
      (chunk.metadataJson === undefined ? 0 : utf8Length(chunk.metadataJson)) +
      dimensions * 4
    if (bytes > MAX_ROW_BYTES) {
      return `chunk '${chunk.id}' of document '${documentId}' is ${bytes} bytes, over the ${MAX_ROW_BYTES} byte row limit`
    }
  }
  return null
}
