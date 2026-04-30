import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson, sendError } from '../../../http.js'
import { resolveModelAlias } from '../../../config.js'
import { sdkEmbed } from '../../../core/sdk.js'
import type { RouteContext } from '../../types.js'

export async function handleEmbeddings (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = await readBody(req)
  } catch {
    sendError(res, 400, 'invalid_json', 'Request body must be valid JSON.')
    return
  }

  if (!body['model']) {
    sendError(res, 400, 'missing_model', '"model" is required.')
    return
  }

  if (!body['input']) {
    sendError(res, 400, 'missing_input', '"input" is required.')
    return
  }

  if (body['encoding_format'] && body['encoding_format'] !== 'float') {
    ctx.logger.warn(`Ignoring unsupported encoding_format: ${body['encoding_format'] as string}`)
  }

  if (body['dimensions']) {
    ctx.logger.warn(`Ignoring unsupported param: dimensions=${body['dimensions'] as string}`)
  }

  const modelName = body['model'] as string
  const modelEntry = resolveModelAlias(ctx.serveConfig, modelName) ?? ctx.registry.getEntry(modelName)

  if (!modelEntry) {
    sendError(res, 404, 'model_not_found', `Model "${modelName}" is not available. Check serve.models config.`)
    return
  }

  const endpointCategory = 'endpointCategory' in modelEntry ? modelEntry.endpointCategory : undefined
  if (endpointCategory !== 'embedding') {
    sendError(res, 400, 'invalid_model_type', `Model "${modelName}" does not support embeddings.`)
    return
  }

  const alias = 'alias' in modelEntry ? (modelEntry.alias as string) : modelEntry.id
  const registryEntry = ctx.registry.getEntry(alias)
  if (!registryEntry || registryEntry.state !== ctx.registry.STATES.READY) {
    sendError(res, 503, 'model_not_ready', `Model "${modelName}" is not loaded yet.`)
    return
  }

  const sdkModelId = registryEntry.sdkModelId ?? registryEntry.id
  const modelAlias = alias
  const input = body['input']
  const inputs = Array.isArray(input) ? input as string[] : [input as string]

  ctx.logger.info(`  embed model=${modelAlias} inputs=${inputs.length}`)

  try {
    const embeddings = await sdkEmbed({
      modelId: sdkModelId,
      text: inputs.length === 1 ? inputs[0]! : inputs
    })

    const isBatch = Array.isArray(embeddings[0])
    const vectors = isBatch ? embeddings as number[][] : [embeddings as number[]]

    const data = vectors.map((vec, index) => ({
      object: 'embedding',
      index,
      embedding: vec
    }))

    ctx.logger.info(`  embed done vectors=${vectors.length} dim=${vectors[0]?.length ?? 0}`)

    sendJson(res, 200, {
      object: 'list',
      data,
      model: modelAlias,
      usage: {
        prompt_tokens: 0,
        total_tokens: 0
      }
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`Embed error for "${modelAlias}": ${message}`)
    sendError(res, 500, 'embed_error', 'An internal error occurred during embedding.')
  }
}
