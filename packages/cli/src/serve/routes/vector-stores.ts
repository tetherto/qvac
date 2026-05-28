import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import {
  ragListWorkspaces,
  ragSearch,
  ragDeleteWorkspace,
  ragCloseWorkspace,
  ragIngest
} from '@qvac/sdk'
import { HttpError } from '../lib/http-error.js'
import {
  vectorStoreIdParams,
  vectorStoreCreateBody,
  vectorStoreUpdateBody,
  vectorStoreSearchBody,
  vectorStoreAttachBody,
  parseExpiresAfter,
  parseMetadata,
  InvalidExpiresAfterError,
  InvalidMetadataError
} from '../schemas/vector-stores.js'
import {
  idToWorkspace,
  InvalidVectorStoreIdError,
  vectorStoreToOpenAI,
  searchResultsToOpenAI,
  type VectorStoreRagInfo,
  type CreateVectorStoreInput,
  type UpdateVectorStoreInput,
  type VectorStoreMeta
} from '../adapters/openai/vector-stores-store.js'
import type { ResolvedModelEntry, ServeConfig } from '../core/model-registry.js'
import type { QvacContext } from '../lib/types.js'

const SYNTHETIC_TIMESTAMP = 0

const descriptions = {
  list: 'Merge of in-memory metadata records and live RAG workspaces. Workspaces with no local metadata appear as synthetics (`createdAt: 0`).',
  create: `
Create an in-memory metadata record for a new vector store. The RAG workspace
itself is created lazily on the first \`POST /v1/vector_stores/{id}/files\`.

**\`file_ids\`** on create is logged as ignored — attach files separately via
\`POST /v1/vector_stores/{id}/files\` after uploading them through
\`POST /v1/files\`.

**\`chunking_strategy\`** is logged as ignored — chunking is configured via the
SDK's ingest options, not per-request.

\`expires_after\` accepts only \`{ anchor: 'last_active_at', days: <positive int> }\`.
`.trim(),
  getById: 'Returns the merged view (local metadata + RAG workspace info). If only the workspace exists, a synthetic record is returned with `createdAt: 0`.',
  updateById: 'Patch `name` / `expires_after` / `metadata` on the in-memory metadata record. If the store exists only as a disk-only RAG workspace, a local metadata record is materialized first.',
  deleteById: 'Delete both the in-memory metadata record AND the underlying RAG workspace. If the RAG delete fails, the metadata is preserved so a retry sees the same state (avoids losing caller-supplied fields).',
  search: `
Vector search over a workspace via SDK \`ragSearch()\`.

**Requires an embedding model** configured under \`serve.models\`. Exactly one
default embedding (or a single embedding alias) must resolve, or the request
fails with \`no_embedding_model_configured\` / \`ambiguous_embedding_model\`.

**Embedding-model mismatch**: if the store was ingested under a different
embedding alias, requests are rejected with \`embedding_model_mismatch\` to
prevent silent precision loss.

**Ignored params** (logged, not rejected): \`filters\`, \`ranking_options\`,
\`rewrite_query\`. Only \`max_num_results\` (mapped to SDK \`topK\`) is
forwarded.

Hit attribution carries the original upload's \`file_id\` and \`filename\`
when known (from the \`POST /v1/vector_stores/{id}/files\` step); falls back
to the raw chunk id for workspaces ingested out-of-band.
`.trim(),
  attachFile: `
Ingest a previously-uploaded ephemeral file (\`POST /v1/files\`) into the
RAG workspace.

**UTF-8 text only.** Binary uploads are rejected with
\`unsupported_file_type\` via a NUL-byte sniff over the first 8 KB
(catches PDF/PNG/DOCX/etc.). Empty-after-trim text is rejected with
\`empty_file\`.

**Side effects**: on success the file is removed from the ephemeral-files
store, the store's \`embeddingAlias\` is recorded, and per-chunk attributions
are stored so subsequent searches return the file's id / filename instead of
opaque chunk ids.

Same embedding-model resolution + mismatch rules as
\`POST /v1/vector_stores/{id}/search\`.
`.trim()
}

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.get('/v1/vector_stores', {
    schema: {
      tags: ['Vector Stores'],
      summary: 'List vector stores',
      description: descriptions.list
    }
  }, async () => {
    const ctx = app.qvac
    const ragInfo = await safeListWorkspaces(ctx)
    const local = ctx.vectorStores.list()
    const merged = mergeStoresAndWorkspaces(local, ragInfo.workspaces)
    return {
      object: 'list' as const,
      data: merged.map((e) => vectorStoreToOpenAI(e.meta, e.ragInfo)),
      first_id: merged[0]?.meta.id ?? null,
      last_id: merged[merged.length - 1]?.meta.id ?? null,
      has_more: false
    }
  })

  app.post('/v1/vector_stores', {
    schema: {
      body: vectorStoreCreateBody,
      tags: ['Vector Stores'],
      summary: 'Create a vector store',
      description: descriptions.create
    }
  }, async (req) => {
    const ctx = app.qvac
    const body = req.body
    let input: CreateVectorStoreInput
    try { input = parseCreateInput(body as Record<string, unknown>) } catch (err) { throwInputError(err) }

    if (Array.isArray(body.file_ids) && body.file_ids.length > 0) {
      ctx.logger.warn(
        'Ignoring "file_ids" on create: upload with POST /v1/files, then attach with POST /v1/vector_stores/{id}/files.'
      )
    }
    if (body.chunking_strategy !== undefined) {
      ctx.logger.warn('Ignoring "chunking_strategy": chunking is configured via SDK ingest options.')
    }

    let meta: VectorStoreMeta
    try {
      meta = ctx.vectorStores.create(input)
    } catch (err) {
      if (err instanceof InvalidVectorStoreIdError) throwInputError(err)
      throw err
    }
    ctx.logger.info(`  vector_store create id=${meta.id} name=${meta.name ?? '(none)'}`)
    return vectorStoreToOpenAI(meta, { exists: false })
  })

  app.get('/v1/vector_stores/:id', {
    schema: {
      params: vectorStoreIdParams,
      tags: ['Vector Stores'],
      summary: 'Get a vector store',
      description: descriptions.getById
    }
  }, async (req) => {
    const ctx = app.qvac
    const id = decodeId(req.params.id)
    const ragInfo = await safeListWorkspaces(ctx)
    const meta = ctx.vectorStores.get(id) ?? syntheticFromWorkspace(id, ragInfo.workspaces)
    if (!meta) throw new HttpError(404, 'vector_store_not_found', `Vector store "${id}" not found.`)
    return vectorStoreToOpenAI(meta, workspaceInfoFor(id, ragInfo.workspaces))
  })

  app.post('/v1/vector_stores/:id', {
    schema: {
      params: vectorStoreIdParams,
      body: vectorStoreUpdateBody,
      tags: ['Vector Stores'],
      summary: 'Update a vector store',
      description: descriptions.updateById
    }
  }, async (req) => {
    const ctx = app.qvac
    const id = decodeId(req.params.id)
    let update: UpdateVectorStoreInput
    try { update = parseUpdateInput(req.body as Record<string, unknown>) } catch (err) { throwInputError(err) }

    const ragInfo = await safeListWorkspaces(ctx)
    let meta = ctx.vectorStores.get(id)
    if (!meta) {
      const synthetic = syntheticFromWorkspace(id, ragInfo.workspaces)
      if (!synthetic) {
        throw new HttpError(404, 'vector_store_not_found', `Vector store "${id}" not found.`)
      }
      try {
        meta = ctx.vectorStores.create({ id: synthetic.id, name: synthetic.name })
      } catch (err) {
        if (err instanceof InvalidVectorStoreIdError && err.kind === 'duplicate') {
          const existing = ctx.vectorStores.get(id)
          if (!existing) {
            throw new HttpError(404, 'vector_store_not_found', `Vector store "${id}" not found.`)
          }
          meta = existing
        } else {
          throw err
        }
      }
    }

    const updated = ctx.vectorStores.update(meta.id, update)
    if (!updated) throw new HttpError(404, 'vector_store_not_found', `Vector store "${id}" not found.`)
    ctx.logger.info(`  vector_store update id=${updated.id}`)
    return vectorStoreToOpenAI(updated, workspaceInfoFor(id, ragInfo.workspaces))
  })

  app.delete('/v1/vector_stores/:id', {
    schema: {
      params: vectorStoreIdParams,
      tags: ['Vector Stores'],
      summary: 'Delete a vector store',
      description: descriptions.deleteById
    }
  }, async (req) => {
    const ctx = app.qvac
    const id = decodeId(req.params.id)
    const ragInfo = await safeListWorkspaces(ctx)
    const hadMeta = ctx.vectorStores.get(id) !== null
    const workspaceExists = ragInfo.workspaces.some((w) => w.name === id)
    if (!hadMeta && !workspaceExists) {
      throw new HttpError(404, 'vector_store_not_found', `Vector store "${id}" not found.`)
    }
    if (workspaceExists) {
      try {
        await ragDeleteWorkspace({ workspace: id })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        ctx.logger.error(`Failed to delete RAG workspace "${id}": ${message}`)
        throw new HttpError(500, 'vector_store_delete_failed', 'Failed to delete underlying RAG workspace.')
      }
    }
    ctx.vectorStores.delete(id)
    ctx.chunkAttributions.evict(id)
    ctx.logger.info(`  vector_store delete id=${id} workspace=${workspaceExists ? 'deleted' : 'noop'}`)
    return { id, object: 'vector_store.deleted' as const, deleted: true }
  })

  app.post('/v1/vector_stores/:id/search', {
    schema: {
      params: vectorStoreIdParams,
      body: vectorStoreSearchBody,
      tags: ['Vector Stores'],
      summary: 'Search a vector store',
      description: descriptions.search
    }
  }, async (req) => {
    const ctx = app.qvac
    const id = decodeId(req.params.id)
    const body = req.body
    for (const param of ['filters', 'ranking_options', 'rewrite_query'] as const) {
      if (body[param] !== undefined) ctx.logger.warn(`Ignoring unsupported vector_store search param: ${param}`)
    }
    const topK = body.max_num_results

    const ragInfo = await safeListWorkspaces(ctx)
    const meta = ctx.vectorStores.get(id) ?? syntheticFromWorkspace(id, ragInfo.workspaces)
    if (!meta) throw new HttpError(404, 'vector_store_not_found', `Vector store "${id}" not found.`)

    const embedding = resolveEmbeddingModel(ctx)
    if (!embedding.ok) throw new HttpError(embedding.status, embedding.code, embedding.message)
    if (meta.embeddingAlias !== null && meta.embeddingAlias !== embedding.entry.alias) {
      throw new HttpError(
        400,
        'embedding_model_mismatch',
        `Vector store "${id}" was previously ingested with embedding "${meta.embeddingAlias}"; ` +
        `current request resolves to "${embedding.entry.alias}". Mark "${meta.embeddingAlias}" as the default ` +
        'embedding under serve.models, or create a new vector store.'
      )
    }

    ctx.vectorStores.touch(id)
    ctx.logger.info(
      `  vector_store search id=${id} model=${embedding.entry.alias} q.len=${body.query.length}${topK ? ` topK=${topK}` : ''}`
    )

    try {
      const results = await ragSearch({
        modelId: embedding.sdkModelId,
        query: body.query,
        ...(topK !== undefined ? { topK } : {}),
        workspace: id
      })
      return searchResultsToOpenAI(results, body.query, (chunkId) => ctx.chunkAttributions.lookup(id, chunkId))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.logger.error(`Vector store search error for "${id}": ${message}`)
      throw new HttpError(500, 'vector_store_search_failed', 'An internal error occurred during vector store search.')
    } finally {
      await closeWorkspaceQuiet(ctx, id, 'search')
    }
  })

  app.post('/v1/vector_stores/:id/files', {
    schema: {
      params: vectorStoreIdParams,
      body: vectorStoreAttachBody,
      tags: ['Vector Stores'],
      summary: 'Attach a file to a vector store',
      description: descriptions.attachFile
    }
  }, async (req) => {
    const ctx = app.qvac
    const id = decodeId(req.params.id)
    const fileId = req.body.file_id

    const ragInfo = await safeListWorkspaces(ctx)
    let meta = ctx.vectorStores.get(id)
    if (!meta) {
      const synthetic = syntheticFromWorkspace(id, ragInfo.workspaces)
      if (!synthetic) throw new HttpError(404, 'vector_store_not_found', `Vector store "${id}" not found.`)
      try {
        meta = ctx.vectorStores.create({ id: synthetic.id, name: synthetic.name })
      } catch (err) {
        if (err instanceof InvalidVectorStoreIdError && err.kind === 'duplicate') {
          const existing = ctx.vectorStores.get(id)
          if (!existing) throw new HttpError(404, 'vector_store_not_found', `Vector store "${id}" not found.`)
          meta = existing
        } else {
          throw err
        }
      }
    }

    const embedding = resolveEmbeddingModel(ctx)
    if (!embedding.ok) throw new HttpError(embedding.status, embedding.code, embedding.message)
    if (meta.embeddingAlias !== null && meta.embeddingAlias !== embedding.entry.alias) {
      throw new HttpError(
        400,
        'embedding_model_mismatch',
        `Vector store "${id}" was previously ingested with embedding "${meta.embeddingAlias}"; ` +
        `current request resolves to "${embedding.entry.alias}". Mark "${meta.embeddingAlias}" as the default ` +
        'embedding under serve.models, or create a new vector store.'
      )
    }

    const record = ctx.ephemeralFiles.get(fileId)
    if (record === null) {
      throw new HttpError(
        404,
        'file_not_found',
        `File "${fileId}" not found. Upload bytes with POST /v1/files (multipart) first; files are kept in memory only until attached.`
      )
    }
    if (looksBinary(record.data)) {
      throw new HttpError(
        400,
        'unsupported_file_type',
        'File appears to be binary. This minimal ingest path expects UTF-8 text content (e.g. .txt, .md, .json).'
      )
    }

    const text = record.data.toString('utf8').trim()
    if (text.length === 0) {
      throw new HttpError(
        400,
        'empty_file',
        'File has no UTF-8 text after trim. This minimal ingest path expects text-like content (e.g. .txt, .md, .json).'
      )
    }

    ctx.vectorStores.touch(id)
    ctx.logger.info(
      `  vector_store files attach id=${id} file_id=${fileId} bytes=${record.data.length} embed=${embedding.entry.alias}`
    )

    let ingestResult: { processed: unknown[]; droppedIndices: number[] }
    try {
      ingestResult = await ragIngest({
        modelId: embedding.sdkModelId,
        documents: text,
        workspace: id,
        chunk: true
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.logger.error(`Vector store ingest error for "${id}": ${message}`)
      throw new HttpError(500, 'vector_store_ingest_failed', 'An internal error occurred while ingesting file content into the vector store.')
    } finally {
      await closeWorkspaceQuiet(ctx, id, 'ingest')
    }

    ctx.vectorStores.setEmbedding(id, embedding.entry.alias)
    recordChunkAttributions(ctx, id, fileId, record.fileName, ingestResult.processed)
    ctx.ephemeralFiles.remove(fileId)

    return {
      id: fileId,
      object: 'vector_store.file' as const,
      created_at: Math.floor(Date.now() / 1000),
      vector_store_id: meta.id,
      status: 'completed' as const,
      last_error: null,
      usage_bytes: record.data.length
    }
  })
}

function decodeId (raw: string): string {
  try {
    const id = idToWorkspace(decodeURIComponent(raw))
    return id
  } catch {
    throw new HttpError(400, 'invalid_vector_store_id', 'Vector store id is invalid.')
  }
}

function parseCreateInput (body: Record<string, unknown>): CreateVectorStoreInput {
  const input: CreateVectorStoreInput = {}
  if (body['name'] !== undefined && body['name'] !== null) {
    if (typeof body['name'] !== 'string') throw new InvalidMetadataError('"name" must be a string.')
    input.name = body['name']
  } else if (body['name'] === null) {
    input.name = null
  }
  const expires = parseExpiresAfter(body['expires_after'])
  if (expires !== undefined) input.expiresAfter = expires
  const metadata = parseMetadata(body['metadata'])
  if (metadata !== undefined) input.metadata = metadata ?? {}
  return input
}

function parseUpdateInput (body: Record<string, unknown>): UpdateVectorStoreInput {
  const update: UpdateVectorStoreInput = {}
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = body['name']
    if (name === null) update.name = null
    else if (typeof name === 'string') update.name = name
    else throw new InvalidMetadataError('"name" must be a string or null.')
  }
  if (Object.prototype.hasOwnProperty.call(body, 'expires_after')) {
    const expires = parseExpiresAfter(body['expires_after'])
    if (expires !== undefined) update.expiresAfter = expires
  }
  if (Object.prototype.hasOwnProperty.call(body, 'metadata')) {
    const metadata = parseMetadata(body['metadata'])
    if (metadata !== undefined) update.metadata = metadata
  }
  return update
}

function throwInputError (err: unknown): never {
  if (err instanceof InvalidExpiresAfterError) throw new HttpError(400, 'invalid_expires_after', err.message)
  if (err instanceof InvalidMetadataError) throw new HttpError(400, 'invalid_metadata', err.message)
  if (err instanceof InvalidVectorStoreIdError) {
    if (err.kind === 'duplicate') throw new HttpError(409, 'vector_store_already_exists', err.message)
    throw new HttpError(400, 'invalid_vector_store_id', err.message)
  }
  throw err
}

interface RagInfo {
  workspaces: Array<{ name: string; open: boolean }>
}

async function safeListWorkspaces (ctx: QvacContext): Promise<RagInfo> {
  try {
    const workspaces = await ragListWorkspaces()
    return { workspaces }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.warn(`ragListWorkspaces failed; assuming none: ${message}`)
    return { workspaces: [] }
  }
}

async function closeWorkspaceQuiet (ctx: QvacContext, id: string, op: string): Promise<void> {
  try {
    await ragCloseWorkspace({ workspace: id })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.warn(`ragCloseWorkspace after ${op} failed for "${id}": ${message}`)
  }
}

function workspaceInfoFor (id: string, workspaces: Array<{ name: string; open: boolean }>): VectorStoreRagInfo {
  const found = workspaces.find((w) => w.name === id)
  return found ? { exists: true, open: found.open } : { exists: false }
}

export function syntheticFromWorkspace (id: string, workspaces: Array<{ name: string; open: boolean }>): VectorStoreMeta | null {
  const found = workspaces.find((w) => w.name === id)
  if (!found) return null
  return {
    id,
    createdAt: SYNTHETIC_TIMESTAMP,
    name: id,
    metadata: {},
    expiresAfter: null,
    expiresAt: null,
    lastActiveAt: SYNTHETIC_TIMESTAMP,
    embeddingAlias: null
  }
}

interface MergedEntry { meta: VectorStoreMeta; ragInfo: VectorStoreRagInfo }

function mergeStoresAndWorkspaces (local: VectorStoreMeta[], workspaces: Array<{ name: string; open: boolean }>): MergedEntry[] {
  const seen = new Set<string>()
  const merged: MergedEntry[] = []
  for (const meta of local) {
    seen.add(meta.id)
    merged.push({ meta, ragInfo: workspaceInfoFor(meta.id, workspaces) })
  }
  for (const ws of workspaces) {
    if (seen.has(ws.name)) continue
    const synthetic = syntheticFromWorkspace(ws.name, workspaces)
    if (synthetic) merged.push({ meta: synthetic, ragInfo: { exists: true, open: ws.open } })
  }
  merged.sort((a, b) => b.meta.createdAt - a.meta.createdAt)
  return merged
}

export function looksBinary (data: Buffer): boolean {
  const window = data.length > 8192 ? data.subarray(0, 8192) : data
  return window.includes(0)
}

function recordChunkAttributions (
  ctx: QvacContext,
  vectorStoreId: string,
  fileId: string,
  fileName: string,
  processed: unknown[]
): void {
  for (const entry of processed) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as { status?: unknown; id?: unknown }
    if (e.status !== 'fulfilled') continue
    if (typeof e.id !== 'string') continue
    ctx.chunkAttributions.record(vectorStoreId, e.id, { fileId, fileName })
  }
}

interface EmbeddingResolutionOk { ok: true; entry: ResolvedModelEntry; sdkModelId: string }
interface EmbeddingResolutionErr { ok: false; status: number; code: string; message: string }

function resolveEmbeddingModel (ctx: QvacContext): EmbeddingResolutionOk | EmbeddingResolutionErr {
  const picked = pickDefaultEmbedding(ctx.serveConfig)
  if (picked.kind === 'none') {
    return { ok: false, status: 400, code: 'no_embedding_model_configured', message: 'No embedding model configured. Add an embedding model under serve.models, optionally with default: true.' }
  }
  if (picked.kind === 'ambiguous') {
    return { ok: false, status: 400, code: 'ambiguous_embedding_model', message: `Multiple embedding models configured (${picked.aliases.join(', ')}); none flagged as default. Mark exactly one with default: true.` }
  }
  const entry = picked.entry
  const registryEntry = ctx.registry.getEntry(entry.alias)
  if (!registryEntry || registryEntry.state !== ctx.registry.STATES.READY) {
    return { ok: false, status: 503, code: 'model_not_ready', message: `Embedding model "${entry.alias}" is not loaded yet.` }
  }
  const sdkModelId = registryEntry.sdkModelId ?? registryEntry.id
  return { ok: true, entry, sdkModelId }
}

type PickEmbeddingResult =
  | { kind: 'found'; entry: ResolvedModelEntry }
  | { kind: 'none' }
  | { kind: 'ambiguous'; aliases: string[] }

function pickDefaultEmbedding (serveConfig: ServeConfig): PickEmbeddingResult {
  const embeddings: ResolvedModelEntry[] = []
  let explicitDefault: ResolvedModelEntry | null = null
  for (const [, entry] of serveConfig.models) {
    if (entry.endpointCategory !== 'embedding') continue
    embeddings.push(entry)
    if (entry.isDefault) explicitDefault = entry
  }
  if (explicitDefault) return { kind: 'found', entry: explicitDefault }
  if (embeddings.length === 1) return { kind: 'found', entry: embeddings[0]! }
  if (embeddings.length === 0) return { kind: 'none' }
  return { kind: 'ambiguous', aliases: embeddings.map((e) => e.alias) }
}

export default plugin
