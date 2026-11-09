import { z } from 'zod'

import { QvacErrorRAG, ERR_CODES } from './errors.js'
import { fromZodError } from './validation.js'
import type { DeleteDocumentsParams, IngestOptions } from './types.js'

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

export interface ValidTextChunk {
  id: string
  content: string
  metadataJson?: string
}

// Input the port still has to embed: `chunks` is set for pre-chunked documents.
export interface PendingDocument {
  id: string
  metadata?: Record<string, unknown>
  text?: string
  chunks?: ValidTextChunk[]
}

export type ParsedDocument =
  | { kind: 'embedded'; document: ValidDocument }
  | { kind: 'text'; document: PendingDocument & { text: string } }
  | { kind: 'chunked'; document: PendingDocument & { chunks: ValidTextChunk[] } }

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

const metadataSchema = z.record(z.string(), z.unknown()).optional()

const documentSchema = z
  .object({
    id: z.string().min(1),
    metadata: metadataSchema,
    chunks: z.array(chunkSchema).min(1)
  })
  .strict()

const textDocumentSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    metadata: metadataSchema
  })
  .strict()

const textChunkSchema = z
  .object({
    id: z.string().min(1).optional(),
    content: z.string(),
    metadataJson: z.string().min(1).optional(),
    // Carried by `rag-extract` chunks; not stored.
    tokenCount: z.number().optional()
  })
  .strict()

const chunkedDocumentSchema = z
  .object({
    id: z.string().min(1),
    metadata: metadataSchema,
    chunks: z.array(textChunkSchema).min(1)
  })
  .strict()

const ingestSchema = z
  .object({
    namespace: z.string().min(1),
    documents: z.array(z.unknown()).min(1)
  })
  .strict()

const signalSchema = z.custom<AbortSignal>(
  (value) => typeof (value as { aborted?: unknown } | null)?.aborted === 'boolean',
  'signal must be an AbortSignal'
)

const ingestOptionsSchema = z
  .object({
    signal: signalSchema.optional(),
    onProgress: z.custom<NonNullable<IngestOptions['onProgress']>>(
      (value) => typeof value === 'function',
      'onProgress must be a function'
    )
  })
  .partial()
  .strict()
  .optional()

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
    signal: signalSchema.optional()
  })
  .strict()

const textSearchSchema = z
  .object({
    scope: z.unknown(),
    query: z.string().min(1),
    k: z.number().int().positive(),
    signal: signalSchema.optional()
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

export function parseIngest(params: unknown): {
  namespace: string
  documents: ParsedDocument[]
} {
  const parsed = ingestSchema.safeParse(params)
  if (!parsed.success) throw invalidInput(parsed.error)

  const seen = new Set<string>()
  const documents = parsed.data.documents.map((input, index) => {
    const document = parseDocument(input, `documents.${index}`)
    if (seen.has(document.document.id)) {
      throw new QvacErrorRAG({ code: ERR_CODES.DUPLICATE_DOCUMENT_ID, adds: document.document.id })
    }
    seen.add(document.document.id)
    return document
  })
  return { namespace: parsed.data.namespace, documents }
}

// The shape picks the kind: `text` is a text document, chunks that all carry
// an `embedding` are precomputed, and chunks with none are pre-chunked.
function parseDocument(input: unknown, path: string): ParsedDocument {
  const record = (typeof input === 'object' && input !== null ? input : {}) as {
    text?: unknown
    chunks?: unknown
  }
  if ('text' in record) {
    const doc = parseWith(textDocumentSchema, input, path)
    return {
      kind: 'text',
      document: { id: doc.id, metadata: toJsonMetadata(doc.id, doc.metadata), text: doc.text }
    }
  }

  const chunks = Array.isArray(record.chunks) ? (record.chunks as unknown[]) : []
  const embedded = chunks.filter((chunk) => hasKey(chunk, 'embedding')).length
  if (embedded > 0 && embedded < chunks.length) {
    throw new QvacErrorRAG({
      code: ERR_CODES.INVALID_INPUT,
      adds: `${path}.chunks: either every chunk has an embedding or none does`
    })
  }

  if (embedded === 0 && chunks.length > 0) {
    const doc = parseWith(chunkedDocumentSchema, input, path)
    const ids = chunkIds(
      doc.id,
      doc.chunks.map((chunk) => chunk.id)
    )
    return {
      kind: 'chunked',
      document: {
        id: doc.id,
        metadata: toJsonMetadata(doc.id, doc.metadata),
        chunks: doc.chunks.map((chunk, ordinal) => ({
          id: ids[ordinal],
          content: chunk.content,
          metadataJson: chunk.metadataJson
        }))
      }
    }
  }

  const doc = parseWith(documentSchema, input, path)
  const ids = chunkIds(
    doc.id,
    doc.chunks.map((chunk) => chunk.id)
  )
  return {
    kind: 'embedded',
    document: {
      id: doc.id,
      metadata: toJsonMetadata(doc.id, doc.metadata),
      chunks: doc.chunks.map((chunk, ordinal) => ({
        id: ids[ordinal],
        content: chunk.content,
        metadataJson: chunk.metadataJson,
        embedding: toVector(chunk.embedding, `document '${doc.id}' chunk ${ordinal} embedding`),
        spaceId: chunk.spaceId
      }))
    }
  }
}

function parseWith<T>(schema: z.ZodType<T>, input: unknown, path: string): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw fromZodError(ERR_CODES.INVALID_INPUT, parsed.error, path)
  return parsed.data
}

function hasKey(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && key in value
}

function chunkIds(documentId: string, ids: Array<string | undefined>): string[] {
  const unique = new Set<string>()
  return ids.map((given, ordinal) => {
    const id = given ?? `${documentId}:${ordinal}`
    if (unique.has(id)) {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: `document '${documentId}' has duplicate chunk id '${id}'`
      })
    }
    unique.add(id)
    return id
  })
}

export function parseIngestOptions(options: unknown): IngestOptions {
  const parsed = ingestOptionsSchema.safeParse(options)
  if (!parsed.success) throw invalidInput(parsed.error)
  return { signal: parsed.data?.signal, onProgress: parsed.data?.onProgress }
}

export function parseDelete(params: unknown): DeleteDocumentsParams {
  const parsed = deleteSchema.safeParse(params)
  if (!parsed.success) throw invalidInput(parsed.error)
  return {
    namespace: parsed.data.namespace,
    documentIds: Array.from(new Set(parsed.data.documentIds))
  }
}

export type ValidSearch = {
  scope: unknown
  k: number
  signal?: AbortSignal
} & ({ vector: Float32Array; spaceId: string; query?: undefined } | { query: string })

export function parseSearch(params: unknown): ValidSearch {
  if (hasKey(params, 'query')) {
    const parsed = textSearchSchema.safeParse(params)
    if (!parsed.success) throw invalidInput(parsed.error)
    const { scope, query, k, signal } = parsed.data
    return { scope, query, k, signal }
  }
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
