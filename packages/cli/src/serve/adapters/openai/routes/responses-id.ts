import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendError } from '../../../http.js'
import { RESPONSES_VOLATILE_STUB } from '../responses-store.js'
import type { RouteContext } from '../../types.js'

function setVolatileHeader (res: ServerResponse): void {
  res.setHeader('X-QVAC-Stub', RESPONSES_VOLATILE_STUB)
}

function parseResponsesSubPath (path: string): { id: string; kind: 'input_items' | 'resource' } | null {
  const prefix = '/v1/responses/'
  if (!path.startsWith(prefix)) return null
  const rest = path.slice(prefix.length)
  if (rest.length === 0) return null
  if (rest.endsWith('/input_items')) {
    const id = rest.slice(0, -'/input_items'.length)
    if (!id || id.includes('/')) return null
    return { id, kind: 'input_items' }
  }
  if (rest.includes('/')) return null
  return { id: rest, kind: 'resource' }
}

export async function routeResponsesId (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const method = req.method ?? ''
  const path = (req.url ?? '').split('?')[0] ?? ''
  const parsed = parseResponsesSubPath(path)
  if (!parsed) return false

  if (parsed.kind === 'input_items') {
    if (method !== 'GET') return false
    await handleListInputItems(req, res, ctx, parsed.id)
    return true
  }

  if (method === 'GET') {
    await handleGetResponse(res, ctx, parsed.id)
    return true
  }
  if (method === 'DELETE') {
    await handleDeleteResponse(res, ctx, parsed.id)
    return true
  }

  return false
}

function parseLimit (req: IncomingMessage): number | undefined {
  const q = (req.url ?? '').split('?')[1]
  if (!q) return undefined
  const params = new URLSearchParams(q)
  const raw = params.get('limit')
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

async function handleListInputItems (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  id: string
): Promise<void> {
  setVolatileHeader(res)
  const limit = parseLimit(req)
  const page = limit !== undefined
    ? ctx.responsesStore.listInputItems(id, { limit })
    : ctx.responsesStore.listInputItems(id)
  if (!page) {
    sendError(res, 404, 'response_not_found', `Response "${id}" not found or expired.`)
    return
  }
  sendJson(res, 200, page)
}

async function handleGetResponse (res: ServerResponse, ctx: RouteContext, id: string): Promise<void> {
  setVolatileHeader(res)
  const rec = ctx.responsesStore.get(id)
  if (!rec) {
    sendError(res, 404, 'response_not_found', `Response "${id}" not found or expired.`)
    return
  }
  sendJson(res, 200, rec.responseObject)
}

async function handleDeleteResponse (res: ServerResponse, ctx: RouteContext, id: string): Promise<void> {
  setVolatileHeader(res)
  const ok = ctx.responsesStore.delete(id)
  if (!ok) {
    sendError(res, 404, 'response_not_found', `Response "${id}" not found or expired.`)
    return
  }
  sendJson(res, 200, { id, object: 'response.deleted', deleted: true })
}
