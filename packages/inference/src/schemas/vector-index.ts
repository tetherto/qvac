import { z } from 'zod'

// ============== Storage vocabulary ==============

/**
 * Storage modes of the native vector index. The `TURBOVEC_*` modes are the
 * quantised TurboVec formats and require a dimension divisible by 8 and no
 * greater than 1024. `F32`, `Q8` and `Q4` are the generic stores of the same
 * addon and accept any dimension. Declared as a name-to-value map, like
 * `ModelType`, so the contract carries the names for generated clients.
 */
export const VectorIndexStorage = {
  F32: 'f32',
  Q8: 'q8',
  Q4: 'q4',
  TURBOVEC_Q4: 'turbovec-q4',
  TURBOVEC_Q2: 'turbovec-q2'
} as const
export type VectorIndexStorage = (typeof VectorIndexStorage)[keyof typeof VectorIndexStorage]
export const vectorIndexStorageSchema = z.enum(VectorIndexStorage)
export const DEFAULT_VECTOR_INDEX_STORAGE: VectorIndexStorage = VectorIndexStorage.TURBOVEC_Q4

// ============== Ids ==============

/**
 * The native index pads short search result rows with UINT64_MAX, so that
 * value can never be used as an id.
 */
export const VECTOR_ID_RESERVED = '18446744073709551615'
const RESERVED_ID = BigInt(VECTOR_ID_RESERVED)

const VECTOR_ID_PATTERN = /^(0|[1-9][0-9]{0,19})$/

// Zod runs every check even after the regex fails, so the range check must
// not call BigInt on a string the pattern already rejected.
const vectorIdStringSchema = z
  .string()
  .regex(VECTOR_ID_PATTERN, 'id must be a decimal unsigned 64-bit integer')
  .refine(
    (value) => VECTOR_ID_PATTERN.test(value) && BigInt(value) < RESERVED_ID,
    `id must be below ${VECTOR_ID_RESERVED}`
  )
const vectorIdNumberSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

/**
 * An id as it travels over the wire: a decimal string holding an unsigned
 * 64-bit integer, or a non-negative safe integer. Results always use the
 * string form so values above 2^53 survive JSON.
 */
export const vectorIdWireSchema = z
  .union([vectorIdStringSchema, vectorIdNumberSchema])
  .meta({ title: 'VectorId' })
export type VectorIdWire = z.infer<typeof vectorIdWireSchema>

/** An id as callers pass it. A `bigint` is converted to its decimal string before sending. */
export type VectorId = VectorIdWire | bigint

const vectorIdsSchema = z.array(vectorIdWireSchema).min(1, 'at least one id is required')
const vectorRowSchema = z.array(z.number()).min(1)
const vectorRowsSchema = z.array(vectorRowSchema).min(1, 'at least one vector is required')
const indexIdSchema = z.string().min(1)
const snapshotPathSchema = z.string().min(1, 'path cannot be empty')
const lengthSchema = z.number().int().min(0)

// ============== Operation params ==============

export const createVectorIndexParamsSchema = z.object({
  dim: z.number().int().positive(),
  storage: vectorIndexStorageSchema.default(DEFAULT_VECTOR_INDEX_STORAGE)
})

export const loadVectorIndexParamsSchema = z.object({
  path: snapshotPathSchema
})

export const vectorIndexAddParamsSchema = z.object({
  ids: vectorIdsSchema,
  vectors: vectorRowsSchema
})

export const vectorIndexSearchParamsSchema = z.object({
  queries: vectorRowsSchema,
  k: z.number().int().positive()
})

export const vectorIndexIdsParamsSchema = z.object({
  ids: vectorIdsSchema
})

export const vectorIndexWriteParamsSchema = z.object({
  path: snapshotPathSchema
})

// ============== Requests ==============

const vectorIndexTypeField = { type: z.literal('vectorIndex') }
const handleField = { indexId: indexIdSchema }

const vectorIndexCreateRequestSchema = createVectorIndexParamsSchema.extend({
  ...vectorIndexTypeField,
  operation: z.literal('create')
})

const vectorIndexLoadRequestSchema = loadVectorIndexParamsSchema.extend({
  ...vectorIndexTypeField,
  operation: z.literal('load')
})

const vectorIndexAddRequestSchema = vectorIndexAddParamsSchema.extend({
  ...vectorIndexTypeField,
  ...handleField,
  operation: z.literal('add')
})

const vectorIndexSearchRequestSchema = vectorIndexSearchParamsSchema.extend({
  ...vectorIndexTypeField,
  ...handleField,
  operation: z.literal('search')
})

const vectorIndexRemoveRequestSchema = vectorIndexIdsParamsSchema.extend({
  ...vectorIndexTypeField,
  ...handleField,
  operation: z.literal('remove')
})

const vectorIndexContainsRequestSchema = vectorIndexIdsParamsSchema.extend({
  ...vectorIndexTypeField,
  ...handleField,
  operation: z.literal('contains')
})

const vectorIndexWriteRequestSchema = vectorIndexWriteParamsSchema.extend({
  ...vectorIndexTypeField,
  ...handleField,
  operation: z.literal('write')
})

const vectorIndexDisposeRequestSchema = z.object({
  ...vectorIndexTypeField,
  ...handleField,
  operation: z.literal('dispose')
})

export const vectorIndexRequestSchema = z.discriminatedUnion('operation', [
  vectorIndexCreateRequestSchema,
  vectorIndexLoadRequestSchema,
  vectorIndexAddRequestSchema,
  vectorIndexSearchRequestSchema,
  vectorIndexRemoveRequestSchema,
  vectorIndexContainsRequestSchema,
  vectorIndexWriteRequestSchema,
  vectorIndexDisposeRequestSchema
])

// ============== Responses ==============

export const vectorIndexHitSchema = z.object({
  id: z.string(),
  score: z.number()
})

const vectorIndexResponseBaseSchema = z.object(vectorIndexTypeField)

const vectorIndexCreateResponseSchema = vectorIndexResponseBaseSchema.extend({
  operation: z.literal('create'),
  indexId: indexIdSchema,
  dim: z.number().int().positive(),
  storage: vectorIndexStorageSchema,
  length: lengthSchema
})

// A loaded snapshot reports its storage only when the backend can derive it;
// the native index exposes a bit width, and 4 bits is ambiguous.
const vectorIndexLoadResponseSchema = vectorIndexResponseBaseSchema.extend({
  operation: z.literal('load'),
  indexId: indexIdSchema,
  dim: z.number().int().positive(),
  storage: vectorIndexStorageSchema.optional(),
  length: lengthSchema
})

const vectorIndexAddResponseSchema = vectorIndexResponseBaseSchema.extend({
  operation: z.literal('add'),
  length: lengthSchema
})

const vectorIndexSearchResponseSchema = vectorIndexResponseBaseSchema.extend({
  operation: z.literal('search'),
  results: z.array(z.array(vectorIndexHitSchema))
})

const vectorIndexRemoveResponseSchema = vectorIndexResponseBaseSchema.extend({
  operation: z.literal('remove'),
  removed: z.array(z.boolean()),
  length: lengthSchema
})

const vectorIndexContainsResponseSchema = vectorIndexResponseBaseSchema.extend({
  operation: z.literal('contains'),
  present: z.array(z.boolean())
})

const vectorIndexWriteResponseSchema = vectorIndexResponseBaseSchema.extend({
  operation: z.literal('write'),
  path: z.string()
})

const vectorIndexDisposeResponseSchema = vectorIndexResponseBaseSchema.extend({
  operation: z.literal('dispose'),
  disposed: z.boolean()
})

export const vectorIndexResponseSchema = z.discriminatedUnion('operation', [
  vectorIndexCreateResponseSchema,
  vectorIndexLoadResponseSchema,
  vectorIndexAddResponseSchema,
  vectorIndexSearchResponseSchema,
  vectorIndexRemoveResponseSchema,
  vectorIndexContainsResponseSchema,
  vectorIndexWriteResponseSchema,
  vectorIndexDisposeResponseSchema
])

// ============== Types ==============

export type VectorIndexRequest = z.input<typeof vectorIndexRequestSchema>
export type VectorIndexResponse = z.infer<typeof vectorIndexResponseSchema>
export type VectorIndexHit = z.infer<typeof vectorIndexHitSchema>

export type CreateVectorIndexParams = z.input<typeof createVectorIndexParamsSchema>
export type LoadVectorIndexParams = z.infer<typeof loadVectorIndexParamsSchema>
export interface VectorIndexAddParams {
  ids: VectorId[]
  vectors: number[][]
}
export interface VectorIndexIdsParams {
  ids: VectorId[]
}
export type VectorIndexSearchParams =
  { query: number[]; k: number } | { queries: number[][]; k: number }
export type VectorIndexWriteParams = z.infer<typeof vectorIndexWriteParamsSchema>

// ============== Helpers shared by the in-process and RPC clients ==============

export function toWireVectorIds(ids: readonly VectorId[]): VectorIdWire[] {
  return ids.map((id) => (typeof id === 'bigint' ? id.toString() : id))
}

/** Index of the first row whose length differs from `dim`, or -1 when every row matches. */
export function findVectorRowLengthMismatch(
  rows: readonly (readonly number[])[],
  dim: number
): number {
  return rows.findIndex((row) => row.length !== dim)
}
