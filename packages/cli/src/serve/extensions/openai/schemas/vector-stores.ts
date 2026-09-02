import { z } from 'zod'

export const vectorStoreIdParams = z.object({ id: z.string().min(1) })

export const vectorStoreCreateBody = z
  .object({
    name: z.string().nullable().optional(),
    expires_after: z.unknown().optional(),
    metadata: z.unknown().optional(),
    file_ids: z.array(z.string()).optional(),
    chunking_strategy: z.unknown().optional()
  })
  .passthrough()

export const vectorStoreUpdateBody = z
  .object({
    name: z.string().nullable().optional(),
    expires_after: z.unknown().optional(),
    metadata: z.unknown().optional()
  })
  .passthrough()

export const vectorStoreSearchBody = z
  .object({
    query: z.string().min(1),
    max_num_results: z.number().int().positive().optional(),
    filters: z.unknown().optional(),
    ranking_options: z.unknown().optional(),
    rewrite_query: z.unknown().optional()
  })
  .passthrough()

export const vectorStoreAttachBody = z
  .object({
    file_id: z.string().min(1)
  })
  .passthrough()

// ─── Parsed shapes (source of truth; the store imports these) ─────────

export interface VectorStoreExpiresAfter {
  anchor: 'last_active_at'
  days: number
}

export class InvalidExpiresAfterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidExpiresAfterError'
  }
}

export function parseExpiresAfter(raw: unknown): VectorStoreExpiresAfter | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidExpiresAfterError('"expires_after" must be an object.')
  }
  const obj = raw as Record<string, unknown>
  const anchor = obj['anchor']
  if (anchor !== 'last_active_at') {
    throw new InvalidExpiresAfterError('"expires_after.anchor" must be "last_active_at".')
  }
  const days = obj['days']
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
    throw new InvalidExpiresAfterError('"expires_after.days" must be a positive integer.')
  }
  return { anchor: 'last_active_at', days }
}

export class InvalidMetadataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidMetadataError'
  }
}

const MAX_METADATA_KEYS = 16
const MAX_METADATA_KEY_LENGTH = 64
const MAX_METADATA_VALUE_LENGTH = 512

export function parseMetadata(raw: unknown): Record<string, string> | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidMetadataError('"metadata" must be an object of string values.')
  }
  const obj = raw as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length > MAX_METADATA_KEYS) {
    throw new InvalidMetadataError(`"metadata" has more than ${MAX_METADATA_KEYS} keys.`)
  }
  const out: Record<string, string> = {}
  for (const key of keys) {
    if (key.length > MAX_METADATA_KEY_LENGTH) {
      throw new InvalidMetadataError(
        `"metadata" key "${key}" exceeds ${MAX_METADATA_KEY_LENGTH} characters.`
      )
    }
    const value = obj[key]
    if (typeof value !== 'string') {
      throw new InvalidMetadataError(`"metadata.${key}" must be a string.`)
    }
    if (value.length > MAX_METADATA_VALUE_LENGTH) {
      throw new InvalidMetadataError(
        `"metadata.${key}" exceeds ${MAX_METADATA_VALUE_LENGTH} characters.`
      )
    }
    out[key] = value
  }
  return out
}
