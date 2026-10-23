import { z } from 'zod'
import { VectorIndexStorage } from '@qvac/sdk'

/** Same rule as vector store ids, so a vector store and its workspace share one name. */
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
const NAME_RULE = 'must match [a-zA-Z0-9_-]{1,64}'

/** Each index holds worker memory until deleted, so the count is bounded. */
export const MAX_VECTOR_INDEXES = 64

/** The TurboVec storage modes need a dimension divisible by 8 and no greater than this. */
export const TURBOVEC_MAX_DIM = 1024

const TURBOVEC_STORAGE: readonly string[] = [
  VectorIndexStorage.TURBOVEC_Q4,
  VectorIndexStorage.TURBOVEC_Q2
]

const name = z.string().regex(NAME_PATTERN, NAME_RULE)

export const workspaceParams = z.strictObject({
  workspace: name.describe('Workspace name. The same namespace as `/v1/vector_stores` ids.')
})

export const vectorIndexParams = z.strictObject({
  id: z.string().min(1).describe('Vector index id, as returned on create or load.')
})

const documents = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe('One document, or an array of documents.')

const chunkOpts = z
  .strictObject({
    chunkSize: z.number().int().positive().optional().describe('Target chunk size.'),
    chunkOverlap: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Units shared by neighbouring chunks.'),
    chunkStrategy: z
      .enum(['character', 'paragraph'])
      .optional()
      .describe('Boundaries a chunk may end on.'),
    splitStrategy: z
      .enum(['character', 'word', 'token', 'sentence', 'line'])
      .optional()
      .describe('Unit that `chunkSize` and `chunkOverlap` count.')
  })
  .refine(
    (opts) =>
      opts.chunkSize === undefined ||
      opts.chunkOverlap === undefined ||
      opts.chunkOverlap < opts.chunkSize,
    { message: 'chunkOverlap must be smaller than chunkSize' }
  )
  .describe('Chunking options, as the SDK takes them. Unset fields use the SDK defaults.')

export const chunkBody = z.strictObject({
  documents,
  chunkOpts: chunkOpts.optional()
})

const chunkDoc = z.object({ id: z.string(), content: z.string() })

export const chunkResult = z.object({
  object: z.literal('list'),
  data: z.array(chunkDoc)
})

export const ingestBody = z.strictObject({
  model: z
    .string()
    .min(1)
    .describe('A `serve.models` alias whose endpoint category is `embedding`.'),
  documents,
  chunk: z
    .boolean()
    .optional()
    .describe('Split documents before embedding (default `true`). `false` embeds each whole.'),
  chunkOpts: chunkOpts.optional()
})

const savedChunk = z.object({
  status: z.enum(['fulfilled', 'rejected']),
  id: z.string().optional(),
  error: z.string().optional()
})

export const ingestResult = z.object({
  object: z.literal('rag.ingest'),
  workspace: z.string(),
  model: z.string(),
  processed: z.array(savedChunk).describe('One entry per stored chunk.'),
  droppedIndices: z.array(z.number()).describe('Indices of input documents that produced nothing.')
})

export const reindexResult = z.object({
  object: z.literal('rag.reindex'),
  workspace: z.string(),
  reindexed: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional()
})

const workspaceInfo = z.object({
  object: z.literal('rag.workspace'),
  name: z.string(),
  open: z.boolean().describe('Whether the workspace is loaded in memory.')
})

export const workspaceList = z.object({
  object: z.literal('list'),
  data: z.array(workspaceInfo)
})

export const workspaceDeleted = z.object({
  object: z.literal('rag.workspace.deleted'),
  name: z.string(),
  deleted: z.literal(true)
})

export const workspaceClosed = z.object({
  object: z.literal('rag.workspace'),
  name: z.string(),
  open: z.literal(false)
})

const snapshot = name.describe(
  'Snapshot name. Stored as `vector-indexes/<snapshot>.qvi` under the QVAC data directory.'
)

const storage = z.enum(VectorIndexStorage)

export const createVectorIndexBody = z
  .strictObject({
    dim: z
      .number()
      .int()
      .positive()
      .describe('Vector dimensionality, for example 1024 for GTE Large.'),
    storage: storage
      .optional()
      .describe(
        'Storage mode (default `turbovec-q4`). The `turbovec-*` modes need a dimension divisible by 8 and at most 1024; `f32`, `q8` and `q4` take any dimension.'
      )
  })
  .superRefine((body, ctx) => {
    const turbovec = TURBOVEC_STORAGE.includes(body.storage ?? VectorIndexStorage.TURBOVEC_Q4)
    if (turbovec && (body.dim % 8 !== 0 || body.dim > TURBOVEC_MAX_DIM)) {
      ctx.addIssue({
        code: 'custom',
        path: ['dim'],
        message: `TurboVec storage needs a dimension divisible by 8 and at most ${TURBOVEC_MAX_DIM}; use f32, q8 or q4 for others`
      })
    }
  })

export const loadVectorIndexBody = z.strictObject({ snapshot })

export const writeVectorIndexBody = z.strictObject({ snapshot })

// Strings carry ids above 2^53, which a JSON number cannot.
const VECTOR_ID_PATTERN = /^(0|[1-9][0-9]{0,19})$/
// The native index pads short result rows with 2^64 - 1, so it is never an id.
const RESERVED_VECTOR_ID = 2n ** 64n - 1n

const vectorId = z
  .union([
    z
      .string()
      .refine(
        (value) => VECTOR_ID_PATTERN.test(value) && BigInt(value) < RESERVED_VECTOR_ID,
        'id must be a decimal unsigned 64-bit integer below 2^64 - 1'
      ),
    z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  ])
  .describe('Unsigned 64-bit id, as a decimal string or a safe integer. 2^64 - 1 is reserved.')

const ids = z.array(vectorId).min(1)
const rows = z.array(z.array(z.number()).min(1)).min(1)

export const addVectorsBody = z.strictObject({
  ids: ids.describe('One id per row of `vectors`.'),
  vectors: rows.describe('Rows of length `dim`. L2-normalize them for cosine similarity.')
})

export const vectorIdsBody = z.strictObject({ ids })

export const searchVectorsBody = z.strictObject({
  queries: rows.describe('Query rows of length `dim`. One hit list comes back per row.'),
  k: z.number().int().positive().describe('Hits to return per query.')
})

export const vectorIndex = z.object({
  id: z.string(),
  object: z.literal('vector_index'),
  dim: z.number(),
  storage: storage
    .nullable()
    .describe('`null` for a loaded 4-bit snapshot, whose mode it does not record.'),
  length: z.number().describe('Live entries.')
})

export const vectorIndexList = z.object({
  object: z.literal('list'),
  data: z.array(vectorIndex)
})

export const vectorIndexDeleted = z.object({
  id: z.string(),
  object: z.literal('vector_index.deleted'),
  deleted: z.literal(true)
})

export const addVectorsResult = z.object({
  id: z.string(),
  object: z.literal('vector_index'),
  length: z.number()
})

const hit = z.object({ id: z.string(), score: z.number() })

export const searchVectorsResult = z.object({
  object: z.literal('vector_index.search'),
  results: z.array(z.array(hit)).describe('One list per query, by descending score then id.')
})

export const removeVectorsResult = z.object({
  id: z.string(),
  object: z.literal('vector_index'),
  length: z.number(),
  removed: z.array(z.boolean()).describe('Per id, in request order: whether it was present.')
})

export const containsVectorsResult = z.object({
  object: z.literal('vector_index.contains'),
  present: z.array(z.boolean()).describe('Per id, in request order.')
})

export const writeVectorIndexResult = z.object({
  id: z.string(),
  object: z.literal('vector_index.snapshot'),
  snapshot: z.string()
})

export const RAG_FIELD_CODES: Record<string, string> = {
  workspace: 'invalid_workspace',
  documents: 'invalid_documents',
  chunk: 'invalid_chunk',
  chunkOpts: 'invalid_chunk_opts',
  dim: 'invalid_dim',
  storage: 'invalid_storage',
  snapshot: 'invalid_snapshot',
  ids: 'invalid_ids',
  vectors: 'invalid_vectors',
  queries: 'invalid_vectors',
  k: 'invalid_k'
}
