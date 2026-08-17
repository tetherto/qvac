import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { HttpError } from '../lib/http-error.js'
import { resolveModelAlias } from '../config.js'
import { loadModel } from '../core/lifecycle.js'
import type { ModelEntry, ResolvedModelEntry } from '../core/model-registry.js'
import type { QvacContext, QvacRequestModel } from '../lib/types.js'

export function requireModel(category: string): preHandlerAsyncHookHandler {
  return async function (req) {
    const body = req.body as Record<string, unknown> | undefined
    const modelName = typeof body?.['model'] === 'string' ? (body['model'] as string).trim() : ''
    req.qvacModel = await resolveAndCheckModel(req, modelName, category)
  }
}

export async function resolveAndCheckModel(
  req: FastifyRequest,
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
  const registryEntry = await ensureReady(ctx, alias, modelEntry, modelName)

  return {
    alias,
    sdkModelId: registryEntry.sdkModelId ?? registryEntry.id,
    entry: registryEntry
  }
}

// Register (if needed) and lazy-load a model, returning its READY registry entry.
// This is the single place that honors `preload: false` — the first request that
// names an idle model loads it, and concurrent requests share that one load.
export async function ensureReady(
  ctx: QvacContext,
  alias: string,
  configEntry: ResolvedModelEntry | ModelEntry,
  modelName: string
): Promise<ModelEntry> {
  let entry = ctx.registry.getEntry(alias)
  if (!entry) {
    entry = ctx.registry.register(alias, configEntry)
  }

  if (entry.state !== ctx.registry.STATES.READY) {
    try {
      await loadModel(alias, ctx.registry, ctx.logger, ctx.loadModelOverride)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new HttpError(
        503,
        'model_load_failed',
        `Model "${modelName}" failed to load: ${message}`
      )
    }
    entry = ctx.registry.getEntry(alias)
    if (!entry || entry.state !== ctx.registry.STATES.READY) {
      throw new HttpError(503, 'model_not_ready', `Model "${modelName}" is not loaded yet.`)
    }
  }

  return entry
}
