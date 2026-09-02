import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { HttpError } from '@/serve/lib/http-error'
import { resolveModelAlias } from '@/serve/config'
import { ModelLoadTimeoutError } from '@/serve/core/load-manager'
import type { ModelEntry, ResolvedModelEntry } from '@/serve/core/model-registry'
import type { QvacContext, QvacRequestModel } from '@/serve/lib/types'

export function requireModel(category: string): preHandlerAsyncHookHandler {
  return async function (req, reply) {
    const body = req.body as Record<string, unknown> | undefined
    const modelName = typeof body?.['model'] === 'string' ? (body['model'] as string).trim() : ''
    req.qvacModel = await resolveAndCheckModel(req, reply, modelName, category)
  }
}

export async function resolveAndCheckModel(
  req: FastifyRequest,
  reply: FastifyReply,
  modelName: string,
  category: string
): Promise<QvacRequestModel> {
  if (!modelName) {
    throw new HttpError(400, 'missing_model', '"model" is required.')
  }

  const ctx = req.server.qvac
  const modelEntry =
    resolveModelAlias(ctx.serveConfig, modelName) ?? ctx.registry.getEntry(modelName)
  if (!modelEntry) {
    throw new HttpError(
      404,
      'model_not_found',
      `Model "${modelName}" is not available. Check serve.models config.`
    )
  }

  const endpointCategory =
    'endpointCategory' in modelEntry ? modelEntry.endpointCategory : undefined
  if (endpointCategory !== category) {
    throw new HttpError(
      400,
      'invalid_model_type',
      `Model "${modelName}" does not support ${category}.`
    )
  }

  const alias = 'alias' in modelEntry ? (modelEntry.alias as string) : modelEntry.id
  const registryEntry = await ensureReady(ctx, alias, modelEntry, modelName, reply)

  return {
    alias,
    sdkModelId: registryEntry.sdkModelId ?? registryEntry.id,
    entry: registryEntry
  }
}

// Register (if needed) and load a model, returning its READY registry entry.
// Honors `serve.load`: when lazy loading is disabled an unloaded model is a
// 503; otherwise the first request loads it (shared across concurrent callers),
// optionally cancelled if the caller disconnects.
export async function ensureReady(
  ctx: QvacContext,
  alias: string,
  configEntry: ResolvedModelEntry | ModelEntry,
  modelName: string,
  reply?: FastifyReply
): Promise<ModelEntry> {
  let entry = ctx.registry.getEntry(alias)
  if (!entry) {
    entry = ctx.registry.register(alias, configEntry)
  }
  if (entry.state === ctx.registry.STATES.READY) return entry

  if (!ctx.serveConfig.load.lazy) {
    throw new HttpError(
      503,
      'model_not_loaded',
      `Model "${modelName}" is not loaded and lazy loading is disabled. Preload it (preload: true) or enable lazy loading.`
    )
  }

  const disconnect =
    ctx.serveConfig.load.cancelOnDisconnect && reply ? disconnectSignal(reply) : undefined
  try {
    await ctx.loadManager.load(alias, disconnect?.signal)
  } catch (err) {
    if (err instanceof ModelLoadTimeoutError) {
      throw new HttpError(503, 'model_load_timeout', err.message)
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new HttpError(503, 'model_load_failed', `Model "${modelName}" failed to load: ${message}`)
  } finally {
    disconnect?.dispose()
  }

  entry = ctx.registry.getEntry(alias)
  if (!entry || entry.state !== ctx.registry.STATES.READY) {
    throw new HttpError(503, 'model_not_ready', `Model "${modelName}" is not loaded yet.`)
  }
  return entry
}

// Aborts if the client disconnects before the load finishes: `reply.raw` closes
// when the connection drops. Disposed after the load, so a completed response
// never trips it.
function disconnectSignal(reply: FastifyReply): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const onClose = (): void => controller.abort()
  reply.raw.once('close', onClose)
  return { signal: controller.signal, dispose: () => reply.raw.removeListener('close', onClose) }
}
