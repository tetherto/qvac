import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ragListWorkspaces,
  ragSearch,
  ragDeleteWorkspace,
  ragCloseWorkspace,
  ragIngest
} from '@qvac/sdk'
import { readBody, sendJson, sendError } from '../../../http.js'
import {
  vectorStoreToOpenAI,
  searchResultsToOpenAI,
  parseExpiresAfter,
  parseMetadata,
  InvalidExpiresAfterError,
  InvalidMetadataError,
  type VectorStoreRagInfo
} from '../translate.js'
import {
  idToWorkspace,
  InvalidVectorStoreIdError,
  type CreateVectorStoreInput,
  type UpdateVectorStoreInput,
  type VectorStoreMeta
} from '../vector-stores-store.js'
import type { ResolvedModelEntry, ServeConfig } from '../../../core/model-registry.js'
import type { RouteContext } from '../../types.js'

export async function handleListVectorStores (
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext
): Promise<void> {
  const ragInfo = await safeListWorkspaces(ctx)
  const local = ctx.vectorStores.list()
  const merged = mergeStoresAndWorkspaces(local, ragInfo.workspaces)

  sendJson(res, 200, {
    object: 'list',
    data: merged.map((entry) => vectorStoreToOpenAI(entry.meta, entry.ragInfo)),
    first_id: merged[0]?.meta.id ?? null,
    last_id: merged[merged.length - 1]?.meta.id ?? null,
    has_more: false
  })
}

export async function handleCreateVectorStore (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext
): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = await readBody(req)
  } catch {
    sendError(res, 400, 'invalid_json', 'Request body must be valid JSON.')
    return
  }

  let input: CreateVectorStoreInput
  try {
    input = parseCreateInput(body)
  } catch (err) {
    handleInputError(res, err)
    return
  }

  if (Array.isArray(body['file_ids']) && body['file_ids'].length > 0) {
    ctx.logger.warn(
      'Ignoring "file_ids" on create: upload with POST /v1/files, then attach with POST /v1/vector_stores/{id}/files.'
    )
  }
  if (body['chunking_strategy'] !== undefined) {
    ctx.logger.warn('Ignoring "chunking_strategy": chunking is configured via SDK ingest options.')
  }

  let meta: VectorStoreMeta
  try {
    meta = ctx.vectorStores.create(input)
  } catch (err) {
    if (err instanceof InvalidVectorStoreIdError) {
      handleInputError(res, err)
      return
    }
    throw err
  }

  ctx.logger.info(`  vector_store create id=${meta.id} name=${meta.name ?? '(none)'}`)
  sendJson(res, 200, vectorStoreToOpenAI(meta, { exists: false }))
}

export async function handleGetVectorStore (
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  rawId: string
): Promise<void> {
  const id = decodeId(rawId)
  if (id === null) {
    sendError(res, 400, 'invalid_vector_store_id', 'Vector store id is invalid.')
    return
  }

  const ragInfo = await safeListWorkspaces(ctx)
  const meta = ctx.vectorStores.get(id) ?? syntheticFromWorkspace(id, ragInfo.workspaces)
  if (!meta) {
    sendError(res, 404, 'vector_store_not_found', `Vector store "${id}" not found.`)
    return
  }
  sendJson(res, 200, vectorStoreToOpenAI(meta, workspaceInfoFor(id, ragInfo.workspaces)))
}

export async function handleUpdateVectorStore (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  rawId: string
): Promise<void> {
  const id = decodeId(rawId)
  if (id === null) {
    sendError(res, 400, 'invalid_vector_store_id', 'Vector store id is invalid.')
    return
  }

  let body: Record<string, unknown>
  try {
    body = await readBody(req)
  } catch {
    sendError(res, 400, 'invalid_json', 'Request body must be valid JSON.')
    return
  }

  let update: UpdateVectorStoreInput
  try {
    update = parseUpdateInput(body)
  } catch (err) {
    handleInputError(res, err)
    return
  }

  const ragInfo = await safeListWorkspaces(ctx)
  let meta = ctx.vectorStores.get(id)
  if (!meta) {
    const synthetic = syntheticFromWorkspace(id, ragInfo.workspaces)
    if (!synthetic) {
      sendError(res, 404, 'vector_store_not_found', `Vector store "${id}" not found.`)
      return
    }
    try {
      meta = ctx.vectorStores.create({ id: synthetic.id, name: synthetic.name })
    } catch (err) {
      // Race: a concurrent request materialized the same synthetic between
      // get() and create() above. Reuse whatever the winner produced.
      if (err instanceof InvalidVectorStoreIdError && err.kind === 'duplicate') {
        const existing = ctx.vectorStores.get(id)
        if (!existing) {
          // Created-then-deleted within the window — vanishingly unlikely.
          sendError(res, 404, 'vector_store_not_found', `Vector store "${id}" not found.`)
          return
        }
        meta = existing
      } else {
        throw err
      }
    }
  }

  const updated = ctx.vectorStores.update(meta.id, update)
  if (!updated) {
    sendError(res, 404, 'vector_store_not_found', `Vector store "${id}" not found.`)
    return
  }
  ctx.logger.info(`  vector_store update id=${updated.id}`)
  sendJson(res, 200, vectorStoreToOpenAI(updated, workspaceInfoFor(id, ragInfo.workspaces)))
}

export async function handleDeleteVectorStore (
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  rawId: string
): Promise<void> {
  const id = decodeId(rawId)
  if (id === null) {
    sendError(res, 400, 'invalid_vector_store_id', 'Vector store id is invalid.')
    return
  }

  const ragInfo = await safeListWorkspaces(ctx)
  const hadMeta = ctx.vectorStores.get(id) !== null
  const workspaceExists = ragInfo.workspaces.some((w) => w.name === id)

  if (!hadMeta && !workspaceExists) {
    sendError(res, 404, 'vector_store_not_found', `Vector store "${id}" not found.`)
    return
  }

  // RAG first: if it throws, both the workspace and the local meta stay
  // intact so a retry sees the same state. If we deleted the local meta
  // up-front, a partial failure would lose caller-supplied fields
  // (name, expires_after, metadata) permanently — the synthetic-from-
  // workspace fallback in GET only recovers id and an empty record.
  if (workspaceExists) {
    try {
      await ragDeleteWorkspace({ workspace: id })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.logger.error(`Failed to delete RAG workspace "${id}": ${message}`)
      sendError(res, 500, 'vector_store_delete_failed', 'Failed to delete underlying RAG workspace.')
      return
    }
  }

  ctx.vectorStores.delete(id)
  ctx.chunkAttributions.evict(id)

  ctx.logger.info(`  vector_store delete id=${id} workspace=${workspaceExists ? 'deleted' : 'noop'}`)
  sendJson(res, 200, {
    id,
    object: 'vector_store.deleted',
    deleted: true
  })
}

export async function handleSearchVectorStore (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  rawId: string
): Promise<void> {
  const id = decodeId(rawId)
  if (id === null) {
    sendError(res, 400, 'invalid_vector_store_id', 'Vector store id is invalid.')
    return
  }

  let body: Record<string, unknown>
  try {
    body = await readBody(req)
  } catch {
    sendError(res, 400, 'invalid_json', 'Request body must be valid JSON.')
    return
  }

  const query = body['query']
  if (typeof query !== 'string' || query.length === 0) {
    sendError(res, 400, 'missing_query', '"query" must be a non-empty string.')
    return
  }

  for (const param of ['filters', 'ranking_options', 'rewrite_query'] as const) {
    if (body[param] !== undefined) {
      ctx.logger.warn(`Ignoring unsupported vector_store search param: ${param}`)
    }
  }

  const maxNumResults = body['max_num_results']
  let topK: number | undefined
  if (typeof maxNumResults === 'number' && Number.isInteger(maxNumResults) && maxNumResults > 0) {
    topK = maxNumResults
  } else if (maxNumResults !== undefined) {
    sendError(res, 400, 'invalid_max_num_results', '"max_num_results" must be a positive integer.')
    return
  }

  const ragInfo = await safeListWorkspaces(ctx)
  const meta = ctx.vectorStores.get(id) ?? syntheticFromWorkspace(id, ragInfo.workspaces)
  if (!meta) {
    sendError(res, 404, 'vector_store_not_found', `Vector store "${id}" not found.`)
    return
  }

  const embedding = resolveEmbeddingModel(ctx)
  if (!embedding.ok) {
    sendError(res, embedding.status, embedding.code, embedding.message)
    return
  }

  if (meta.embeddingAlias !== null && meta.embeddingAlias !== embedding.entry.alias) {
    sendError(
      res,
      400,
      'embedding_model_mismatch',
      `Vector store "${id}" was previously ingested with embedding "${meta.embeddingAlias}"; ` +
      `current request resolves to "${embedding.entry.alias}". Mark "${meta.embeddingAlias}" as the default ` +
      'embedding under serve.models, or create a new vector store.'
    )
    return
  }

  ctx.vectorStores.touch(id)

  ctx.logger.info(
    `  vector_store search id=${id} model=${embedding.entry.alias} q.len=${query.length}${topK ? ` topK=${topK}` : ''}`
  )

  try {
    const results = await ragSearch({
      modelId: embedding.sdkModelId,
      query,
      ...(topK !== undefined ? { topK } : {}),
      workspace: id
    })
    sendJson(res, 200, searchResultsToOpenAI(results, query, (chunkId) => ctx.chunkAttributions.lookup(id, chunkId)))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`Vector store search error for "${id}": ${message}`)
    sendError(res, 500, 'vector_store_search_failed', 'An internal error occurred during vector store search.')
  } finally {
    await closeWorkspaceQuiet(ctx, id, 'search')
  }
}

export async function handleAttachVectorStoreFile (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  rawId: string
): Promise<void> {
  const id = decodeId(rawId)
  if (id === null) {
    sendError(res, 400, 'invalid_vector_store_id', 'Vector store id is invalid.')
    return
  }

  let body: Record<string, unknown>
  try {
    body = await readBody(req)
  } catch {
    sendError(res, 400, 'invalid_json', 'Request body must be valid JSON.')
    return
  }

  const fileId = body['file_id']
  if (typeof fileId !== 'string' || fileId.length === 0) {
    sendError(res, 400, 'missing_file_id', '"file_id" must be a non-empty string.')
    return
  }

  const ragInfo = await safeListWorkspaces(ctx)
  let meta = ctx.vectorStores.get(id)
  if (!meta) {
    const synthetic = syntheticFromWorkspace(id, ragInfo.workspaces)
    if (!synthetic) {
      sendError(res, 404, 'vector_store_not_found', `Vector store "${id}" not found.`)
      return
    }
    // Materialize a local meta entry for the disk-only workspace so we can
    // record the embedding alias. Uses the same race-guarded pattern as
    // handleUpdateVectorStore.
    try {
      meta = ctx.vectorStores.create({ id: synthetic.id, name: synthetic.name })
    } catch (err) {
      if (err instanceof InvalidVectorStoreIdError && err.kind === 'duplicate') {
        const existing = ctx.vectorStores.get(id)
        if (!existing) {
          sendError(res, 404, 'vector_store_not_found', `Vector store "${id}" not found.`)
          return
        }
        meta = existing
      } else {
        throw err
      }
    }
  }

  const embedding = resolveEmbeddingModel(ctx)
  if (!embedding.ok) {
    sendError(res, embedding.status, embedding.code, embedding.message)
    return
  }

  if (meta.embeddingAlias !== null && meta.embeddingAlias !== embedding.entry.alias) {
    sendError(
      res,
      400,
      'embedding_model_mismatch',
      `Vector store "${id}" was previously ingested with embedding "${meta.embeddingAlias}"; ` +
      `current request resolves to "${embedding.entry.alias}". Mark "${meta.embeddingAlias}" as the default ` +
      'embedding under serve.models, or create a new vector store.'
    )
    return
  }

  const record = ctx.ephemeralFiles.get(fileId)
  if (record === null) {
    sendError(
      res,
      404,
      'file_not_found',
      `File "${fileId}" not found. Upload bytes with POST /v1/files (multipart) first; files are kept in memory only until attached.`
    )
    return
  }

  // Buffer#toString('utf8') is lossy: invalid bytes become U+FFFD and most
  // binaries (PDF / PNG / DOCX) survive .trim() non-empty and would silently
  // ingest garbage. A null-byte sniff catches every common binary format
  // before we waste an embed pass on it.
  if (looksBinary(record.data)) {
    sendError(
      res,
      400,
      'unsupported_file_type',
      'File appears to be binary. This minimal ingest path expects UTF-8 text content (e.g. .txt, .md, .json).'
    )
    return
  }

  const text = record.data.toString('utf8').trim()
  if (text.length === 0) {
    sendError(
      res,
      400,
      'empty_file',
      'File has no UTF-8 text after trim. This minimal ingest path expects text-like content (e.g. .txt, .md, .json).'
    )
    return
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
    sendError(res, 500, 'vector_store_ingest_failed', 'An internal error occurred while ingesting file content into the vector store.')
    return
  } finally {
    await closeWorkspaceQuiet(ctx, id, 'ingest')
  }

  ctx.vectorStores.setEmbedding(id, embedding.entry.alias)
  recordChunkAttributions(ctx, id, fileId, record.fileName, ingestResult.processed)
  ctx.ephemeralFiles.remove(fileId)

  sendJson(res, 200, {
    id: fileId,
    object: 'vector_store.file',
    created_at: Math.floor(Date.now() / 1000),
    vector_store_id: meta.id,
    status: 'completed',
    last_error: null,
    usage_bytes: record.data.length
  })
}

// ---------- internals ----------

/**
 * Cheap heuristic: any NUL byte in the first 8 KB is a strong binary signal
 * (every common text encoding avoids U+0000, and every common binary format
 * — PDF, PNG, JPEG, GZIP, ZIP, DOCX, etc. — has one within the header).
 * Exported for unit testing.
 */
export function looksBinary (data: Buffer): boolean {
  const window = data.length > 8192 ? data.subarray(0, 8192) : data
  return window.includes(0)
}

/**
 * Record per-chunk attribution so subsequent search hits can carry the
 * uploaded file's `file_id` and `filename` instead of an opaque chunk id.
 * Defensive against the SDK's `processed[i]` shape — we only treat entries
 * with `status === 'fulfilled'` and a string `id` as recordable.
 */
function recordChunkAttributions (
  ctx: RouteContext,
  vectorStoreId: string,
  fileId: string,
  fileName: string,
  processed: unknown[]
): void {
  for (const entry of processed) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as { status?: unknown, id?: unknown }
    if (e.status !== 'fulfilled') continue
    if (typeof e.id !== 'string') continue
    ctx.chunkAttributions.record(vectorStoreId, e.id, { fileId, fileName })
  }
}

interface RagInfo {
  workspaces: Array<{ name: string; open: boolean }>
}

async function closeWorkspaceQuiet (ctx: RouteContext, id: string, op: string): Promise<void> {
  try {
    await ragCloseWorkspace({ workspace: id })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.warn(`ragCloseWorkspace after ${op} failed for "${id}": ${message}`)
  }
}

async function safeListWorkspaces (ctx: RouteContext): Promise<RagInfo> {
  try {
    const workspaces = await ragListWorkspaces()
    return { workspaces }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.warn(`ragListWorkspaces failed; assuming none: ${message}`)
    return { workspaces: [] }
  }
}

function workspaceInfoFor (
  id: string,
  workspaces: Array<{ name: string; open: boolean }>
): VectorStoreRagInfo {
  const found = workspaces.find((w) => w.name === id)
  return found ? { exists: true, open: found.open } : { exists: false }
}

/**
 * Stable sentinel for disk-only (workspace-but-no-local-meta) synthetics.
 * Using 0 keeps GET responses deterministic across reads, sorts these
 * reconstructed-from-disk entries last in list responses (smallest
 * createdAt), and honestly signals "timestamp unknown" to OpenAI clients.
 */
const SYNTHETIC_TIMESTAMP = 0

export function syntheticFromWorkspace (
  id: string,
  workspaces: Array<{ name: string; open: boolean }>
): VectorStoreMeta | null {
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

interface MergedEntry {
  meta: VectorStoreMeta
  ragInfo: VectorStoreRagInfo
}

function mergeStoresAndWorkspaces (
  local: VectorStoreMeta[],
  workspaces: Array<{ name: string; open: boolean }>
): MergedEntry[] {
  const seen = new Set<string>()
  const merged: MergedEntry[] = []
  for (const meta of local) {
    seen.add(meta.id)
    merged.push({ meta, ragInfo: workspaceInfoFor(meta.id, workspaces) })
  }
  for (const ws of workspaces) {
    if (seen.has(ws.name)) continue
    const synthetic = syntheticFromWorkspace(ws.name, workspaces)
    if (synthetic) {
      merged.push({ meta: synthetic, ragInfo: { exists: true, open: ws.open } })
    }
  }
  merged.sort((a, b) => b.meta.createdAt - a.meta.createdAt)
  return merged
}

function decodeId (raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw)
    return idToWorkspace(decoded)
  } catch {
    return null
  }
}

function parseCreateInput (body: Record<string, unknown>): CreateVectorStoreInput {
  const input: CreateVectorStoreInput = {}
  if (body['name'] !== undefined && body['name'] !== null) {
    if (typeof body['name'] !== 'string') {
      throw new InvalidMetadataError('"name" must be a string.')
    }
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
    if (name === null) {
      update.name = null
    } else if (typeof name === 'string') {
      update.name = name
    } else {
      throw new InvalidMetadataError('"name" must be a string or null.')
    }
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

function handleInputError (res: ServerResponse, err: unknown): void {
  if (err instanceof InvalidExpiresAfterError) {
    sendError(res, 400, 'invalid_expires_after', err.message)
    return
  }
  if (err instanceof InvalidMetadataError) {
    sendError(res, 400, 'invalid_metadata', err.message)
    return
  }
  if (err instanceof InvalidVectorStoreIdError) {
    if (err.kind === 'duplicate') {
      sendError(res, 409, 'vector_store_already_exists', err.message)
    } else {
      sendError(res, 400, 'invalid_vector_store_id', err.message)
    }
    return
  }
  throw err
}

interface EmbeddingResolutionOk {
  ok: true
  entry: ResolvedModelEntry
  sdkModelId: string
}

interface EmbeddingResolutionErr {
  ok: false
  status: number
  code: string
  message: string
}

function resolveEmbeddingModel (ctx: RouteContext): EmbeddingResolutionOk | EmbeddingResolutionErr {
  const picked = pickDefaultEmbedding(ctx.serveConfig)
  if (picked.kind === 'none') {
    return {
      ok: false,
      status: 400,
      code: 'no_embedding_model_configured',
      message: 'No embedding model configured. Add an embedding model under serve.models, optionally with default: true.'
    }
  }
  if (picked.kind === 'ambiguous') {
    return {
      ok: false,
      status: 400,
      code: 'ambiguous_embedding_model',
      message: `Multiple embedding models configured (${picked.aliases.join(', ')}); none flagged as default. Mark exactly one with default: true.`
    }
  }
  const entry = picked.entry
  const registryEntry = ctx.registry.getEntry(entry.alias)
  if (!registryEntry || registryEntry.state !== ctx.registry.STATES.READY) {
    return {
      ok: false,
      status: 503,
      code: 'model_not_ready',
      message: `Embedding model "${entry.alias}" is not loaded yet.`
    }
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

export const META = {
  endpoints: [
    'GET /v1/vector_stores',
    'POST /v1/vector_stores',
    'GET /v1/vector_stores/{vector_store_id}',
    'POST /v1/vector_stores/{vector_store_id}',
    'DELETE /v1/vector_stores/{vector_store_id}',
    'POST /v1/vector_stores/{vector_store_id}/search',
    'POST /v1/vector_stores/{vector_store_id}/files'
  ],
  caveats: ['in-memory metadata; survives process lifetime only']
} as const
