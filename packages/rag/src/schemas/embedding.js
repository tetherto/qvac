'use strict'

const { z } = require('zod')

// ============== Input Schemas ==============

const embeddingInputSchema = z.union([
  z.string().trim().min(1, 'Text cannot be empty'),
  z.array(z.string().trim().min(1, 'Text array element cannot be empty')).min(1, 'Text array cannot be empty')
])

// ============== Output Schemas ==============

const singleEmbeddingSchema = z.array(z.number()).min(1, 'Embedding cannot be empty')

const batchEmbeddingSchema = z.array(
  z.array(z.number()).min(1, 'Individual embedding cannot be empty')
).min(1, 'Batch embeddings cannot be empty')

// ============== Document Schemas ==============

// Base document (for embedding generation)
const docSchema = z.object({
  id: z.string().trim().min(1, 'Document id is required'),
  content: z.string().trim().min(1, 'Document content is required')
})

const docsArraySchema = z.array(docSchema).min(1, 'Documents array cannot be empty')

// Embedded document (for saving)
const embeddedDocSchema = docSchema.extend({
  embedding: z.array(z.number()).min(1, 'Embedding cannot be empty'),
  embeddingModelId: z.string().min(1, 'embeddingModelId is required'),
  metadata: z.record(z.any()).optional()
}).strict()

const embeddedDocsArraySchema = z.array(embeddedDocSchema).min(1, 'Documents array cannot be empty')

module.exports = {
  embeddingInputSchema,
  singleEmbeddingSchema,
  batchEmbeddingSchema,
  docSchema,
  docsArraySchema,
  embeddedDocSchema,
  embeddedDocsArraySchema
}
