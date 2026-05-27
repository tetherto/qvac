import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { HttpError } from '../lib/http-error.js'
import { resolveModelAlias } from '../config.js'
import type { QvacRequestModel } from '../lib/types.js'

export function requireModel (category: string): preHandlerAsyncHookHandler {
  return async function (req) {
    const body = req.body as Record<string, unknown> | undefined
    const modelName = typeof body?.['model'] === 'string' ? (body['model'] as string).trim() : ''
    req.qvacModel = resolveAndCheckModel(req, modelName, category)
  }
}

export function resolveAndCheckModel (req: FastifyRequest, modelName: string, category: string): QvacRequestModel {
  if (!modelName) {
    throw new HttpError(400, 'missing_model', '"model" is required.')
  }

  const ctx = req.server.qvac
  const modelEntry = resolveModelAlias(ctx.serveConfig, modelName) ?? ctx.registry.getEntry(modelName)
  if (!modelEntry) {
    throw new HttpError(404, 'model_not_found', `Model "${modelName}" is not available. Check serve.models config.`)
  }

  const endpointCategory = 'endpointCategory' in modelEntry ? modelEntry.endpointCategory : undefined
  if (endpointCategory !== category) {
    throw new HttpError(400, 'invalid_model_type', `Model "${modelName}" does not support ${category}.`)
  }

  const alias = 'alias' in modelEntry ? (modelEntry.alias as string) : modelEntry.id
  const registryEntry = ctx.registry.getEntry(alias)
  if (!registryEntry || registryEntry.state !== ctx.registry.STATES.READY) {
    throw new HttpError(503, 'model_not_ready', `Model "${modelName}" is not loaded yet.`)
  }

  return {
    alias,
    sdkModelId: registryEntry.sdkModelId ?? registryEntry.id,
    entry: registryEntry
  }
}
