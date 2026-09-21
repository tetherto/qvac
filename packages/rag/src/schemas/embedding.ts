import { z } from 'zod'

// ============== Input Schemas ==============

export const embeddingInputSchema = z.union([
  z.string().trim().min(1, 'Text cannot be empty'),
  z
    .array(z.string().trim().min(1, 'Text array element cannot be empty'))
    .min(1, 'Text array cannot be empty')
])

// ============== Output Schemas ==============

export const singleEmbeddingSchema = z.array(z.number()).min(1, 'Embedding cannot be empty')

export const batchEmbeddingSchema = z
  .array(z.array(z.number()).min(1, 'Individual embedding cannot be empty'))
  .min(1, 'Batch embeddings cannot be empty')

// ============== Document Schemas ==============

// Base document (for embedding generation)
export const docSchema = z.object({
  id: z.string().trim().min(1, 'Document id is required'),
  content: z.string().trim().min(1, 'Document content is required')
})

export const docsArraySchema = z.array(docSchema).min(1, 'Documents array cannot be empty')

// Embedded document (for saving)
export const embeddedDocSchema = docSchema
  .extend({
    embedding: z.array(z.number()).min(1, 'Embedding cannot be empty'),
    embeddingModelId: z.string().min(1, 'embeddingModelId is required'),
    metadata: z.record(z.string(), z.any()).optional()
  })
  .strict()

export const embeddedDocsArraySchema = z
  .array(embeddedDocSchema)
  .min(1, 'Documents array cannot be empty')
