import { z } from 'zod'

import { QvacErrorRAG, ERR_CODES } from './errors.js'
import { fromZodError } from './validation.js'
import type { DeleteDocumentsParams } from './types.js'

export interface ValidChunk {
  id: string
  content: string
  metadataJson?: string
  embedding: Float32Array
  spaceId: string
}

export interface ValidDocument {
  id: string
  metadata?: Record<string, unknown>
  chunks: ValidChunk[]
}

const vectorSchema = z.union([z.instanceof(Float32Array), z.array(z.number())])

const chunkSchema = z
  .object({
    id: z.string().min(1).optional(),
    content: z.string(),
    // The encoding stores '' as absent, so it could not be read back.
    metadataJson: z.string().min(1).optional(),
    embedding: vectorSchema,
    spaceId: z.string().min(1)
  })
  .strict()

const documentSchema = z
  .object({
    id: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
    chunks: z.array(chunkSchema).min(1)
  })
  .strict()

const ingestSchema = z
  .object({
    namespace: z.string().min(1),
    documents: z.array(documentSchema).min(1)
  })
  .strict()

const deleteSchema = z
  .object({
    namespace: z.string().min(1),
    documentIds: z.array(z.string().min(1))
  })
  .strict()

const searchSchema = z
  .object({
    scope: z.unknown(),
    vector: vectorSchema,
    spaceId: z.string().min(1),
    k: z.number().int().positive(),
    signal: z
      .custom<AbortSignal>(
        (value) => typeof (value as { aborted?: unknown } | null)?.aborted === 'boolean',
        'signal must be an AbortSignal'
      )
      .optional()
  })
  .strict()

function invalidInput(error: z.ZodError): QvacErrorRAG {
  return fromZodError(ERR_CODES.INVALID_INPUT, error)
}

// Always copies, so a caller reusing its buffer can't change a pending call.
export function toVector(value: Float32Array | number[], label: string): Float32Array {
  const vector = Float32Array.from(value)
  if (vector.length === 0) {
    throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: `${label} is empty` })
  }
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: `${label} has a non-finite value at ${i}`
      })
    }
  }
  return vector
}

// Metadata is stored as JSON, so anything JSON can't encode is rejected before
// the first write rather than failing midway through the batch.
function toJsonMetadata(
  id: string,
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>
  } catch (error) {
    throw new QvacErrorRAG({
      code: ERR_CODES.INVALID_INPUT,
      adds: `document '${id}' metadata is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`
    })
  }
}

export function parseIngest(params: unknown): { namespace: string; documents: ValidDocument[] } {
  const parsed = ingestSchema.safeParse(params)
  if (!parsed.success) throw invalidInput(parsed.error)

  const seen = new Set<string>()
  const documents = parsed.data.documents.map((doc) => {
    if (seen.has(doc.id)) {
      throw new QvacErrorRAG({ code: ERR_CODES.DUPLICATE_DOCUMENT_ID, adds: doc.id })
    }
    seen.add(doc.id)

    const chunkIds = new Set<string>()
    const chunks = doc.chunks.map((chunk, ordinal) => {
      const id = chunk.id ?? `${doc.id}:${ordinal}`
      if (chunkIds.has(id)) {
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_INPUT,
          adds: `document '${doc.id}' has duplicate chunk id '${id}'`
        })
      }
      chunkIds.add(id)
      return {
        id,
        content: chunk.content,
        metadataJson: chunk.metadataJson,
        embedding: toVector(chunk.embedding, `document '${doc.id}' chunk ${ordinal} embedding`),
        spaceId: chunk.spaceId
      }
    })
    return { id: doc.id, metadata: toJsonMetadata(doc.id, doc.metadata), chunks }
  })
  return { namespace: parsed.data.namespace, documents }
}

export function parseDelete(params: unknown): DeleteDocumentsParams {
  const parsed = deleteSchema.safeParse(params)
  if (!parsed.success) throw invalidInput(parsed.error)
  return {
    namespace: parsed.data.namespace,
    documentIds: Array.from(new Set(parsed.data.documentIds))
  }
}

export interface ValidSearch {
  scope: unknown
  vector: Float32Array
  spaceId: string
  k: number
  signal?: AbortSignal
}

export function parseSearch(params: unknown): ValidSearch {
  const parsed = searchSchema.safeParse(params)
  if (!parsed.success) throw invalidInput(parsed.error)
  return {
    scope: parsed.data.scope,
    vector: toVector(parsed.data.vector, 'vector'),
    spaceId: parsed.data.spaceId,
    k: parsed.data.k,
    signal: parsed.data.signal
  }
}

export function parseNamespaceName(name: unknown): string {
  const parsed = z.string().min(1).safeParse(name)
  if (!parsed.success) throw invalidInput(parsed.error)
  return parsed.data
}
