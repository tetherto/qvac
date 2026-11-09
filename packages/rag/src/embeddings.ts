import { chunkRagDocuments } from 'rag-extract/chunk'
import { z } from 'zod'

import { QvacErrorRAG, ERR_CODES } from './errors.js'
import { computeSpaceId, parseEmbeddingSpace } from './space.js'
import { fromZodError } from './validation.js'
import type { ValidTextChunk } from './input.js'
import type { EmbeddingSpace, EmbeddingsPort } from './types.js'

// Texts sent to the port per call; the signal is checked between calls.
export const EMBED_BATCH_SIZE = 32

export interface Embedder {
  space: EmbeddingSpace
  spaceId: string
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
  embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array>
}

const portSchema = z.object({
  space: z.unknown(),
  embedDocuments: z.custom<EmbeddingsPort['embedDocuments']>(
    (value) => typeof value === 'function',
    'embedDocuments must be a function'
  ),
  embedQuery: z.custom<EmbeddingsPort['embedQuery']>(
    (value) => typeof value === 'function',
    'embedQuery must be a function'
  )
})

export function createEmbedder(port: unknown): Embedder | null {
  if (port === undefined) return null
  const parsed = portSchema.safeParse(port)
  if (!parsed.success) {
    throw new QvacErrorRAG({
      code: ERR_CODES.INVALID_INPUT,
      adds: `embeddings: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
    })
  }
  const space = parseEmbeddingSpace(parsed.data.space)
  const spaceId = computeSpaceId(space)
  // Called as methods, so a class-based port keeps its `this`.
  const target = port as EmbeddingsPort

  return {
    space,
    spaceId,
    async embedDocuments(texts, signal) {
      const output = await callPort(() => target.embedDocuments(texts, { signal }), signal)
      return splitRows(output, texts.length, space.dimensions)
    },
    async embedQuery(text, signal) {
      const output = await callPort(() => target.embedQuery(text, { signal }), signal)
      return splitRows(output, 1, space.dimensions)[0]
    }
  }
}

// A port that rejects because the signal aborted is a cancellation, not a failure.
async function callPort(
  run: () => Promise<Float32Array>,
  signal: AbortSignal | undefined
): Promise<Float32Array> {
  if (signal?.aborted) throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
  try {
    return await run()
  } catch (error) {
    if (signal?.aborted) throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    throw new QvacErrorRAG({
      code: ERR_CODES.EMBEDDING_FAILED,
      adds: error instanceof Error ? error.message : String(error),
      cause: error instanceof Error ? error : undefined
    })
  }
}

function splitRows(output: unknown, rows: number, dims: number): Float32Array[] {
  if (!(output instanceof Float32Array)) {
    throw new QvacErrorRAG({
      code: ERR_CODES.EMBEDDING_FAILED,
      adds: 'the embeddings port did not return a Float32Array'
    })
  }
  if (output.length !== rows * dims) {
    throw new QvacErrorRAG({
      code: ERR_CODES.EMBEDDING_DIMENSION_MISMATCH,
      adds: `the embeddings port returned ${output.length} values for ${rows} texts of ${dims} dimensions`
    })
  }
  for (let i = 0; i < output.length; i++) {
    if (!Number.isFinite(output[i])) {
      throw new QvacErrorRAG({
        code: ERR_CODES.EMBEDDING_FAILED,
        adds: `the embeddings port returned a non-finite value at ${i}`
      })
    }
  }
  // Copies, so a port reusing its output buffer can't change pending rows.
  const result: Float32Array[] = []
  for (let row = 0; row < rows; row++) {
    result.push(output.slice(row * dims, (row + 1) * dims))
  }
  return result
}

const chunkingSchema = z
  .object({
    chunkSize: z.number().int().positive().optional(),
    chunkOverlap: z.number().int().nonnegative().optional()
  })
  .strict()
  .refine(
    ({ chunkSize = DEFAULT_CHUNK_SIZE, chunkOverlap = DEFAULT_CHUNK_OVERLAP }) =>
      chunkOverlap < chunkSize,
    'chunkOverlap must be smaller than chunkSize'
  )
  .optional()

// The `rag-extract/chunk` defaults, repeated so the overlap check knows them.
const DEFAULT_CHUNK_SIZE = 256
const DEFAULT_CHUNK_OVERLAP = 50

export type Chunker = (id: string, text: string) => ValidTextChunk[]

// Chunk IDs are `<id>:<index>`. rag-extract clamps bad options silently, so
// they are rejected here instead.
export function createChunker(options: unknown): Chunker {
  const parsed = chunkingSchema.safeParse(options)
  if (!parsed.success) throw fromZodError(ERR_CODES.INVALID_INPUT, parsed.error, 'chunking')
  const chunking = parsed.data ?? {}
  return (id, text) =>
    chunkRagDocuments([{ id, title: '', content: text }], chunking).map((chunk) => ({
      id: chunk.id,
      content: chunk.content,
      metadataJson: chunk.metadataJson
    }))
}
