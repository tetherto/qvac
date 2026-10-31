import qvacCrypto from '#crypto'
import { z } from 'zod'

import { QvacErrorRAG, ERR_CODES } from './errors.js'
import type { EmbeddingSpace } from './types.js'

const embeddingSpaceSchema = z
  .object({
    model: z.string().min(1),
    revision: z.string(),
    dimensions: z.number().int().positive(),
    metric: z.enum(['dot', 'cosine']),
    normalized: z.boolean(),
    documentEncoding: z.string(),
    queryEncoding: z.string(),
    preprocessing: z.string()
  })
  .strict()

export function parseEmbeddingSpace(space: unknown): EmbeddingSpace {
  const parsed = embeddingSpaceSchema.safeParse(space)
  if (!parsed.success) {
    throw new QvacErrorRAG({
      code: ERR_CODES.INVALID_INPUT,
      adds: `space: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
    })
  }
  return parsed.data
}

// The field order is fixed so the same space always hashes to the same ID.
export function computeSpaceId(space: EmbeddingSpace): string {
  const canonical = JSON.stringify([
    'qvac-rag-space-v1',
    space.model,
    space.revision,
    space.dimensions,
    space.metric,
    space.normalized,
    space.documentEncoding,
    space.queryEncoding,
    space.preprocessing
  ])
  return qvacCrypto.createHash('sha256').update(canonical).digest('hex') as string
}
