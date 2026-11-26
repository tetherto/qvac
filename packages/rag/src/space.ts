import qvacCrypto from '#crypto'
import { z } from 'zod'

import { ERR_CODES } from './errors.js'
import { fromZodError } from './validation.js'
import { name, text } from './limits.js'
import type { EmbeddingSpace } from './types.js'

const embeddingSpaceSchema = z
  .object({
    model: name,
    revision: text,
    dimensions: z.number().int().positive(),
    metric: z.enum(['dot', 'cosine']),
    normalized: z.boolean(),
    documentEncoding: text,
    queryEncoding: text,
    preprocessing: text
  })
  .strict()

export function parseEmbeddingSpace(space: unknown): EmbeddingSpace {
  const parsed = embeddingSpaceSchema.safeParse(space)
  if (!parsed.success) throw fromZodError(ERR_CODES.INVALID_INPUT, parsed.error, 'space')
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
