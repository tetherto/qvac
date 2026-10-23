import { randomBytes } from 'node:crypto'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import {
  createVectorIndex,
  loadVectorIndex,
  SDK_CLIENT_ERROR_CODES,
  SDK_SERVER_ERROR_CODES,
  type VectorIndex
} from '@qvac/sdk'
import type { QvacContext } from '@/serve/core/context'
import { errorResponses, type ErrorCodes } from '@/serve/lib/error-responses'
import { HttpError } from '@/serve/lib/http-error'
import {
  MAX_VECTOR_INDEXES,
  addVectorsBody,
  addVectorsResult,
  containsVectorsResult,
  createVectorIndexBody,
  loadVectorIndexBody,
  removeVectorsResult,
  searchVectorsBody,
  searchVectorsResult,
  vectorIdsBody,
  vectorIndex,
  vectorIndexDeleted,
  vectorIndexList,
  vectorIndexParams,
  writeVectorIndexBody,
  writeVectorIndexResult
} from '@/serve/extensions/default/schemas/rag'

const BASE = '/qvac/v1/rag/vector_indexes'

const descriptions = {
  create: `
Create an empty vector index in worker memory, backed by the SDK's
\`createVectorIndex()\`. It holds vectors under ids you choose and nothing else:
keep the documents wherever suits you and map hit ids back to them. Pair it
with \`POST /v1/embeddings\` to build retrieval over any store.

Indexes live until deleted or until the server stops; at most
${MAX_VECTOR_INDEXES} are open at once. Persist one with \`.../write\` and bring
it back with \`.../load\`.
`.trim(),
  load: 'Load a snapshot written by `POST .../{id}/write` into a new index.',
  list: 'Every open vector index.',
  get: 'One open vector index.',
  remove: 'Release an index from worker memory. Its snapshots stay on disk.',
  add: `
Add vectors under the given ids in one atomic batch. Each row must have \`dim\`
components. Scores are dot products, so L2-normalize rows (and queries) for
cosine similarity. Ids already present are refused.
`.trim(),
  search:
    'Find the `k` nearest entries to each query row. Fewer than `k` come back when the index holds fewer.',
  delete: 'Remove ids. Applied in order, so a failure leaves the ids before it removed.',
  contains: 'Report, per id, whether the index holds it.',
  write:
    'Write a checksummed snapshot under the QVAC data directory, replacing one of the same name.'
}

const ID_404 = { 404: { vector_index_not_found: 'No open index has that id' } }
const UNAVAILABLE_503 = {
  503: { vector_index_unavailable: 'No registered plugin provides a vector index' }
}

function routeErrors(
  bad: ErrorCodes,
  extra: Record<number, ErrorCodes> = {}
): ReturnType<typeof errorResponses> {
  return errorResponses({
    400: { invalid_json: 'Body is not valid JSON', ...bad },
    ...extra,
    500: { vector_index_failed: 'The native index failed the operation' }
  })
}

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.qvac
  const indexes = new Map<string, VectorIndex>()
  let reserved = 0

  function get(id: string): VectorIndex {
    const index = indexes.get(id)
    if (!index) {
      throw new HttpError(404, 'vector_index_not_found', `Vector index "${id}" not found.`)
    }
    return index
  }

  // Counts in-flight opens too, so concurrent creates cannot pass the cap together.
  async function open(make: () => Promise<VectorIndex>, notFoundCode?: string) {
    if (indexes.size + reserved >= MAX_VECTOR_INDEXES) {
      throw new HttpError(
        409,
        'too_many_vector_indexes',
        `${MAX_VECTOR_INDEXES} vector indexes are open. Delete one first.`
      )
    }
    reserved++
    try {
      const index = await vectorCall(ctx, '', make, notFoundCode)
      const id = `vi_${randomBytes(12).toString('hex')}`
      indexes.set(id, index)
      return describe(id, index)
    } finally {
      reserved--
    }
  }

  // A worker restart drops every index, so a not-found from the SDK retires the id too.
  async function onIndex<T>(id: string, run: (index: VectorIndex) => Promise<T>): Promise<T> {
    const index = get(id)
    try {
      return await vectorCall(ctx, id, () => run(index))
    } catch (err) {
      if (err instanceof HttpError && err.code === 'vector_index_not_found') indexes.delete(id)
      throw err
    }
  }

  app.post(
    BASE,
    {
      schema: {
        body: createVectorIndexBody,
        response: {
          200: vectorIndex,
          ...routeErrors(
            {
              invalid_dim: '`dim` is not a positive integer, or does not suit TurboVec storage',
              invalid_storage: '`storage` is not a known mode',
              invalid_request: 'The body carries an unknown field'
            },
            {
              409: { too_many_vector_indexes: `${MAX_VECTOR_INDEXES} indexes are already open` },
              ...UNAVAILABLE_503
            }
          )
        },
        tags: ['RAG'],
        summary: 'Create a vector index',
        description: descriptions.create
      }
    },
    async (req) => {
      const { dim, storage } = req.body
      ctx.logger.info(`  vector index create dim=${dim} storage=${storage ?? 'default'}`)
      return await open(() => createVectorIndex({ dim, ...(storage !== undefined && { storage }) }))
    }
  )

  app.post(
    `${BASE}/load`,
    {
      schema: {
        body: loadVectorIndexBody,
        response: {
          200: vectorIndex,
          ...routeErrors(
            {
              invalid_snapshot: '`snapshot` is not `[a-zA-Z0-9_-]{1,64}`',
              invalid_request: 'The body carries an unknown field'
            },
            {
              404: { snapshot_not_found: 'The snapshot is missing, corrupt, or not an index' },
              409: { too_many_vector_indexes: `${MAX_VECTOR_INDEXES} indexes are already open` },
              ...UNAVAILABLE_503
            }
          )
        },
        tags: ['RAG'],
        summary: 'Load a vector index snapshot',
        description: descriptions.load
      }
    },
    async (req) => {
      const { snapshot } = req.body
      ctx.logger.info(`  vector index load snapshot=${snapshot}`)
      return await open(
        () => loadVectorIndex({ path: snapshotPath(snapshot) }),
        'snapshot_not_found'
      )
    }
  )

  app.get(
    BASE,
    {
      schema: {
        response: { 200: vectorIndexList },
        tags: ['RAG'],
        summary: 'List vector indexes',
        description: descriptions.list
      }
    },
    () => ({
      object: 'list' as const,
      data: [...indexes].map(([id, index]) => describe(id, index))
    })
  )

  app.get(
    `${BASE}/:id`,
    {
      schema: {
        params: vectorIndexParams,
        response: { 200: vectorIndex, ...errorResponses(ID_404) },
        tags: ['RAG'],
        summary: 'Get a vector index',
        description: descriptions.get
      }
    },
    (req) => describe(req.params.id, get(req.params.id))
  )

  app.delete(
    `${BASE}/:id`,
    {
      schema: {
        params: vectorIndexParams,
        response: { 200: vectorIndexDeleted, ...routeErrors({}, ID_404) },
        tags: ['RAG'],
        summary: 'Delete a vector index',
        description: descriptions.remove
      }
    },
    async (req) => {
      const { id } = req.params
      const index = get(id)
      try {
        await vectorCall(ctx, id, () => index.dispose())
      } catch (err) {
        // Already gone from the worker: the id is retired either way.
        if (!(err instanceof HttpError && err.code === 'vector_index_not_found')) throw err
      }
      indexes.delete(id)
      ctx.logger.info(`  vector index delete id=${id}`)
      return { id, object: 'vector_index.deleted' as const, deleted: true as const }
    }
  )

  app.post(
    `${BASE}/:id/add`,
    {
      schema: {
        params: vectorIndexParams,
        body: addVectorsBody,
        response: {
          200: addVectorsResult,
          ...routeErrors(
            {
              invalid_ids: '`ids` is missing, malformed, repeats an id, or names one already held',
              invalid_vectors: '`vectors` is missing, or a row does not have `dim` components',
              invalid_request: 'The body carries an unknown field'
            },
            ID_404
          )
        },
        tags: ['RAG'],
        summary: 'Add vectors',
        description: descriptions.add
      }
    },
    async (req) => {
      const { id } = req.params
      const { ids, vectors } = req.body
      if (ids.length !== vectors.length) {
        throw new HttpError(
          400,
          'invalid_vectors',
          `${ids.length} ids were given for ${vectors.length} vectors; give one id per row.`
        )
      }
      const keys = ids.map(String)
      if (new Set(keys).size !== keys.length) {
        throw new HttpError(400, 'invalid_ids', '`ids` repeats an id.')
      }
      // The native add reports a present id only as a generic failure.
      const { length } = await onIndex(id, async (index) => {
        const present = await index.contains({ ids })
        const taken = keys.filter((_, i) => present[i])
        if (taken.length > 0) {
          throw new HttpError(
            400,
            'invalid_ids',
            `The index already holds ${taken.slice(0, 5).join(', ')}${taken.length > 5 ? ', ...' : ''}. Remove them first.`
          )
        }
        return await index.add({ ids, vectors })
      })
      return { id, object: 'vector_index' as const, length }
    }
  )

  app.post(
    `${BASE}/:id/search`,
    {
      schema: {
        params: vectorIndexParams,
        body: searchVectorsBody,
        response: {
          200: searchVectorsResult,
          ...routeErrors(
            {
              invalid_vectors: '`queries` is missing, or a row does not have `dim` components',
              invalid_k: '`k` is not a positive integer',
              invalid_request: 'The body carries an unknown field'
            },
            ID_404
          )
        },
        tags: ['RAG'],
        summary: 'Search a vector index',
        description: descriptions.search
      }
    },
    async (req) => {
      const { queries, k } = req.body
      const results = await onIndex(req.params.id, (index) => index.search({ queries, k }))
      return { object: 'vector_index.search' as const, results }
    }
  )

  app.post(
    `${BASE}/:id/remove`,
    {
      schema: {
        params: vectorIndexParams,
        body: vectorIdsBody,
        response: {
          200: removeVectorsResult,
          ...routeErrors(
            {
              invalid_ids: '`ids` is missing, empty or malformed',
              invalid_request: 'The body carries an unknown field'
            },
            ID_404
          )
        },
        tags: ['RAG'],
        summary: 'Remove vectors',
        description: descriptions.delete
      }
    },
    async (req) => {
      const { id } = req.params
      const removed = await onIndex(id, (index) => index.remove({ ids: req.body.ids }))
      return { id, object: 'vector_index' as const, length: get(id).length, removed }
    }
  )

  app.post(
    `${BASE}/:id/contains`,
    {
      schema: {
        params: vectorIndexParams,
        body: vectorIdsBody,
        response: {
          200: containsVectorsResult,
          ...routeErrors(
            {
              invalid_ids: '`ids` is missing, empty or malformed',
              invalid_request: 'The body carries an unknown field'
            },
            ID_404
          )
        },
        tags: ['RAG'],
        summary: 'Check vector ids',
        description: descriptions.contains
      }
    },
    async (req) => {
      const present = await onIndex(req.params.id, (index) => index.contains({ ids: req.body.ids }))
      return { object: 'vector_index.contains' as const, present }
    }
  )

  app.post(
    `${BASE}/:id/write`,
    {
      schema: {
        params: vectorIndexParams,
        body: writeVectorIndexBody,
        response: {
          200: writeVectorIndexResult,
          ...routeErrors(
            {
              invalid_snapshot: '`snapshot` is not `[a-zA-Z0-9_-]{1,64}`',
              invalid_request: 'The body carries an unknown field'
            },
            ID_404
          )
        },
        tags: ['RAG'],
        summary: 'Write a vector index snapshot',
        description: descriptions.write
      }
    },
    async (req) => {
      const { id } = req.params
      const { snapshot } = req.body
      ctx.logger.info(`  vector index write id=${id} snapshot=${snapshot}`)
      await onIndex(id, (index) => index.write({ path: snapshotPath(snapshot) }))
      return { id, object: 'vector_index.snapshot' as const, snapshot }
    }
  )
}

// A relative path resolves under the QVAC data directory, so a request names a
// snapshot and never a location of its own.
function snapshotPath(snapshot: string): string {
  return `vector-indexes/${snapshot}.qvi`
}

function describe(id: string, index: VectorIndex) {
  return {
    id,
    object: 'vector_index' as const,
    dim: index.dim,
    storage: index.storage ?? null,
    length: index.length
  }
}

// `notFoundCode` names what a native failure means when the operation reads a
// file the caller named (a load), rather than an internal failure.
async function vectorCall<T>(
  ctx: QvacContext,
  id: string,
  call: () => Promise<T>,
  notFoundCode?: string
): Promise<T> {
  try {
    return await call()
  } catch (err) {
    if (err instanceof HttpError) throw err
    const code = (err as { code?: unknown } | null)?.code
    const detail = err instanceof Error ? err.message : String(err)
    switch (code) {
      case SDK_SERVER_ERROR_CODES.VECTOR_INDEX_PROVIDER_UNAVAILABLE:
        throw new HttpError(
          503,
          'vector_index_unavailable',
          'No vector index provider is registered on this server.'
        )
      case SDK_SERVER_ERROR_CODES.VECTOR_INDEX_NOT_FOUND:
        throw new HttpError(404, 'vector_index_not_found', `Vector index "${id}" not found.`)
      case SDK_SERVER_ERROR_CODES.VECTOR_INDEX_INVALID_VECTORS:
      case SDK_CLIENT_ERROR_CODES.REQUEST_VALIDATION_FAILED:
        throw new HttpError(400, 'invalid_vectors', detail)
      case SDK_SERVER_ERROR_CODES.VECTOR_INDEX_FAILED:
        if (notFoundCode !== undefined) {
          throw new HttpError(
            404,
            notFoundCode,
            'Snapshot is missing, corrupt, or not a vector index.'
          )
        }
    }
    ctx.logger.error(`  vector_index_failed${id ? ` id=${id}` : ''}: ${detail}`)
    throw new HttpError(500, 'vector_index_failed', 'The vector index operation failed.')
  }
}

export default plugin
