import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendError } from '../../../http.js'
import type { ModelEntry } from '../../../core/model-registry.js'
import type { RouteContext } from '../../types.js'

export function handleListModels (_req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
  const entries = ctx.registry.getReady()

  sendJson(res, 200, {
    object: 'list',
    data: entries.map(toModelObject)
  })
}

export function handleGetModel (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
  const modelId = extractModelId(req.url ?? '')
  const entry = ctx.registry.getEntry(modelId)

  if (!entry || entry.state !== ctx.registry.STATES.READY) {
    sendError(res, 404, 'model_not_found', `Model "${modelId}" not found or not loaded.`)
    return
  }

  sendJson(res, 200, toModelObject(entry))
}

export async function handleDeleteModel (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  const modelId = extractModelId(req.url ?? '')
  const entry = ctx.registry.getEntry(modelId)

  if (!entry) {
    sendError(res, 404, 'model_not_found', `Model "${modelId}" not found.`)
    return
  }

  const { unloadModel } = await import('../../../core/lifecycle.js')
  await unloadModel(modelId, ctx.registry, ctx.logger)

  sendJson(res, 200, {
    id: modelId,
    object: 'model',
    deleted: true
  })
}

function extractModelId (url: string): string {
  const path = url.split('?')[0] ?? ''
  return decodeURIComponent(path.replace('/v1/models/', ''))
}

function toModelObject (entry: ModelEntry): {
  id: string
  object: string
  created: number
  owned_by: string
} {
  return {
    id: entry.id,
    object: 'model',
    created: Math.floor(entry.createdAt / 1000),
    owned_by: 'qvac'
  }
}
