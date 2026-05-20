import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendError } from '../../../http.js'
import { readMultipart } from '../../../multipart.js'
import type { EphemeralFileRecord } from '../ephemeral-files-store.js'
import type { RouteContext } from '../../types.js'

function toOpenAIFile (id: string, record: EphemeralFileRecord): Record<string, unknown> {
  return {
    object: 'file',
    id,
    bytes: record.data.length,
    created_at: Math.floor(record.createdAtMs / 1000),
    filename: record.fileName,
    purpose: record.purpose,
    status: 'uploaded'
  }
}

/**
 * Minimal OpenAI-style `POST /v1/files`: multipart upload, bytes kept in memory only
 * until attached to a vector store (then removed). No durable metadata across restarts.
 */
export async function handlePostFile (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.includes('multipart/form-data')) {
    sendError(res, 400, 'invalid_content_type', 'Content-Type must be multipart/form-data.')
    return
  }

  let fields: Map<string, string>
  let file: { fieldName: string; fileName: string; contentType: string; data: Buffer } | null

  try {
    const result = await readMultipart(req)
    fields = result.fields
    file = result.file
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`Multipart parse error (files): ${message}`)
    sendError(res, 400, 'invalid_multipart', 'Failed to parse multipart request.')
    return
  }

  if (!file || file.fieldName !== 'file') {
    sendError(res, 400, 'missing_file', '"file" field is required.')
    return
  }

  const purposeRaw = fields.get('purpose')
  const purpose = purposeRaw !== undefined && purposeRaw.length > 0 ? purposeRaw : 'assistants'

  const id = ctx.ephemeralFiles.put({
    data: file.data,
    fileName: file.fileName.length > 0 ? file.fileName : 'upload.bin',
    purpose
  })

  ctx.logger.info(`  files upload id=${id} bytes=${file.data.length} purpose=${purpose}`)

  const rec = ctx.ephemeralFiles.get(id)
  if (rec === null) {
    sendError(res, 500, 'internal_error', 'File was uploaded but could not be retrieved.')
    return
  }
  sendJson(res, 200, toOpenAIFile(id, rec))
}

/**
 * Minimal `GET /v1/files`: lists currently-in-memory uploaded files.
 * Files are dropped from the store on `POST /v1/vector_stores/{id}/files`,
 * so this only shows files that have not been attached yet.
 */
export function handleListFiles (_req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
  const entries = ctx.ephemeralFiles.list()
  sendJson(res, 200, {
    object: 'list',
    data: entries.map(({ id, record }) => toOpenAIFile(id, record)),
    has_more: false
  })
}

/**
 * Minimal `GET /v1/files/{file_id}`: retrieves a single in-memory file's metadata.
 */
export function handleGetFile (
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  rawId: string
): void {
  const id = decodeURIComponent(rawId)
  const record = ctx.ephemeralFiles.get(id)
  if (record === null) {
    sendError(res, 404, 'file_not_found', `File "${id}" not found.`)
    return
  }
  sendJson(res, 200, toOpenAIFile(id, record))
}

/**
 * `GET /v1/files/{file_id}/content`: returns the raw bytes with the stored
 * `Content-Type`. Used by image routes to back `response_format=url`.
 *
 * Sets `Cache-Control: private, max-age=<ttl-remaining>` so downstream proxies
 * and browsers cannot serve stale bytes after the in-memory store has evicted
 * them. Falls back to `private, no-store` when no TTL is configured.
 */
export function handleGetFileContent (
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  rawId: string
): void {
  const id = decodeURIComponent(rawId)
  const record = ctx.ephemeralFiles.get(id)
  if (record === null) {
    sendError(res, 404, 'file_not_found', `File "${id}" not found.`)
    return
  }

  let cacheControl = 'private, no-store'
  if (record.expiresAtMs !== null) {
    const remainingSec = Math.max(0, Math.floor((record.expiresAtMs - Date.now()) / 1000))
    cacheControl = `private, max-age=${remainingSec}`
  }

  res.writeHead(200, {
    'Content-Type': record.contentType,
    'Content-Length': record.data.length.toString(),
    'Cache-Control': cacheControl
  })
  res.end(record.data)
}

export const META = {
  endpoints: [
    'GET /v1/files',
    'POST /v1/files',
    'GET /v1/files/{file_id}',
    'GET /v1/files/{file_id}/content'
  ],
  caveats: ['ephemeral in-memory store']
} as const
