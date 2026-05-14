import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson, sendError, initSSE, sendSSE, endSSE } from '../../../http.js'
import { resolveModelAlias } from '../../../config.js'
import { sdkDiffusion } from '../../../core/sdk.js'
import {
  extractImageGenerationParams,
  encodeImageDataUrl,
  logImageUnsupportedParams,
  InvalidImagePromptError,
  InvalidImageSizeError,
  InvalidImageBatchCountError
} from '../translate.js'
import type { RouteContext } from '../../types.js'

const SUPPORTED_RESPONSE_FORMATS = new Set(['b64_json', 'url'])
const RESPONSE_OUTPUT_FORMAT = 'png' as const

export async function handleImagesGenerations (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
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

  const responseFormat = (body['response_format'] as string | undefined) ?? 'b64_json'
  if (!SUPPORTED_RESPONSE_FORMATS.has(responseFormat)) {
    sendError(res, 400, 'invalid_response_format', `Unknown response_format "${responseFormat}". Use "b64_json" or "url".`)
    return
  }

  const modelName = body['model'] as string
  const modelEntry = resolveModelAlias(ctx.serveConfig, modelName) ?? ctx.registry.getEntry(modelName)

  if (!modelEntry) {
    sendError(res, 404, 'model_not_found', `Model "${modelName}" is not available. Check serve.models config.`)
    return
  }

  const endpointCategory = 'endpointCategory' in modelEntry ? modelEntry.endpointCategory : undefined
  if (endpointCategory !== 'image') {
    sendError(res, 400, 'invalid_model_type', `Model "${modelName}" does not support image generation.`)
    return
  }

  const alias = 'alias' in modelEntry ? (modelEntry.alias as string) : modelEntry.id
  const registryEntry = ctx.registry.getEntry(alias)
  if (!registryEntry || registryEntry.state !== ctx.registry.STATES.READY) {
    sendError(res, 503, 'model_not_ready', `Model "${modelName}" is not loaded yet.`)
    return
  }

  const sdkModelId = registryEntry.sdkModelId ?? registryEntry.id

  let params
  try {
    params = extractImageGenerationParams(body, sdkModelId)
  } catch (err) {
    if (err instanceof InvalidImagePromptError) {
      sendError(res, 400, 'missing_prompt', err.message)
      return
    }
    if (err instanceof InvalidImageSizeError) {
      sendError(res, 400, 'invalid_size', err.message)
      return
    }
    if (err instanceof InvalidImageBatchCountError) {
      sendError(res, 400, 'invalid_n', err.message)
      return
    }
    throw err
  }

  logImageUnsupportedParams(body, ctx.logger)

  const wantsStream = body['stream'] === true
  const dims = params.width && params.height ? `${params.width}x${params.height}` : 'default'
  ctx.logger.info(`  image_generate model=${alias} prompt_chars=${params.prompt.length} size=${dims} n=${params.batch_count ?? 1} response_format=${responseFormat} stream=${wantsStream}`)

  try {
    const { buffers, stats } = await sdkDiffusion({
      params,
      onProgress: (tick) => {
        ctx.logger.debug?.(`    diffusion step=${tick.step}/${tick.totalSteps} elapsed=${tick.elapsedMs}ms`)
      }
    })

    if (stats?.seed != null) {
      ctx.logger.info(`  image_generate done images=${buffers.length} seed=${stats.seed} ms=${stats.totalGenerationMs ?? stats.totalWallMs ?? 0}`)
    } else {
      ctx.logger.info(`  image_generate done images=${buffers.length} ms=${stats?.totalGenerationMs ?? stats?.totalWallMs ?? 0}`)
    }

    const sizeStr = buildSizeString(params.width, params.height, stats?.width, stats?.height)

    if (wantsStream) {
      sendStreamingResponse(res, buffers, sizeStr)
      return
    }

    const data = buffers.map((buf) => {
      if (responseFormat === 'url') {
        return { url: encodeImageDataUrl(buf) }
      }
      return { b64_json: Buffer.from(buf).toString('base64') }
    })

    sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      output_format: RESPONSE_OUTPUT_FORMAT,
      ...(sizeStr ? { size: sizeStr } : {}),
      data
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`Image generation error for "${alias}": ${message}`)
    sendError(res, 500, 'image_generation_error', 'An internal error occurred during image generation.')
  }
}

/**
 * Stream the generated images as Server-Sent Events.
 *
 * The diffusion addon does not emit intermediate image bytes (only step ticks via
 * `progressStream`), so we cannot produce `image_generation.partial_image` events
 * faithfully. Instead we emit one `image_generation.completed` event per generated
 * image, which matches OpenAI's documented behaviour for `partial_images=0` ("a
 * single image sent in one streaming event"). Multiple images (`n > 1`) are
 * emitted as multiple `completed` events on the same stream, then `[DONE]`.
 */
function sendStreamingResponse (res: ServerResponse, buffers: Uint8Array[], sizeStr: string | null): void {
  initSSE(res)
  const createdAt = Math.floor(Date.now() / 1000)
  for (const buf of buffers) {
    sendSSE(res, {
      type: 'image_generation.completed',
      created_at: createdAt,
      output_format: RESPONSE_OUTPUT_FORMAT,
      ...(sizeStr ? { size: sizeStr } : {}),
      b64_json: Buffer.from(buf).toString('base64')
    })
  }
  endSSE(res)
}

function buildSizeString (
  paramW: number | undefined,
  paramH: number | undefined,
  statsW: number | undefined,
  statsH: number | undefined
): string | null {
  const w = statsW ?? paramW
  const h = statsH ?? paramH
  if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
    return `${w}x${h}`
  }
  return null
}
