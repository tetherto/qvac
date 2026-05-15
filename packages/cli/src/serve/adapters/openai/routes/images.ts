import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson, sendError, initSSE, sendSSE, endSSE } from '../../../http.js'
import { readMultipart, type MultipartFile } from '../../../multipart.js'
import { resolveModelAlias } from '../../../config.js'
import { sdkDiffusion, type SDKDiffusionParams } from '../../../core/sdk.js'
import {
  extractImageGenerationParams,
  logImageUnsupportedParams,
  assertSupportedImageOutputParams,
  coerceMultipartFields,
  extractImageEditParams,
  logImageEditExtraWarnings,
  InvalidImagePromptError,
  InvalidImageSizeError,
  InvalidImageBatchCountError,
  InvalidImageStrengthError,
  UnsupportedImageOutputError
} from '../translate.js'
import type { EphemeralFilesStore } from '../ephemeral-files-store.js'
import type { RouteContext } from '../../types.js'

const SUPPORTED_RESPONSE_FORMATS = new Set(['b64_json', 'url'])
const RESPONSE_OUTPUT_FORMAT = 'png' as const
const RESPONSE_CONTENT_TYPE = 'image/png' as const

function buildImageData (
  buffers: Uint8Array[],
  responseFormat: string,
  publicBaseUrl: string,
  ephemeralFiles: EphemeralFilesStore
): Array<{ b64_json: string } | { url: string; expires_at?: number }> {
  if (responseFormat !== 'url') {
    return buffers.map((buf) => ({ b64_json: Buffer.from(buf).toString('base64') }))
  }
  return buffers.map((buf, i) => {
    const id = ephemeralFiles.put({
      data: Buffer.from(buf),
      fileName: `image-${Date.now()}-${i}.png`,
      purpose: 'image_generation',
      contentType: RESPONSE_CONTENT_TYPE
    })
    const url = `${publicBaseUrl}/v1/files/${id}/content`
    const stored = ephemeralFiles.get(id)
    if (stored?.expiresAtMs != null) {
      return { url, expires_at: Math.floor(stored.expiresAtMs / 1000) }
    }
    return { url }
  })
}

function rejectUrlWithoutBaseUrl (res: ServerResponse): void {
  sendError(res, 400, 'unsupported_response_format',
    'response_format="url" requires the server to be started with --public-base-url ' +
    '(or `serve.publicBaseUrl` in the config). This deployment has not configured a ' +
    'public origin, so it cannot mint downloadable URLs. Use response_format="b64_json" instead.'
  )
}

interface ResolvedImageRequest {
  responseFormat: string
  alias: string
  sdkModelId: string
}

/**
 * Shared validation + model resolution for /v1/images/generations and
 * /v1/images/edits. Returns null after writing an HTTP error to `res` when
 * any precondition fails; otherwise returns the resolved request context so
 * the caller can extract route-specific params.
 */
function validateImageRequest (
  res: ServerResponse,
  ctx: RouteContext,
  body: Record<string, unknown>
): ResolvedImageRequest | null {
  if (!body['model']) {
    sendError(res, 400, 'missing_model', '"model" is required.')
    return null
  }

  const responseFormat = (body['response_format'] as string | undefined) ?? 'b64_json'
  if (!SUPPORTED_RESPONSE_FORMATS.has(responseFormat)) {
    sendError(res, 400, 'invalid_response_format', `Unknown response_format "${responseFormat}". Use "b64_json" or "url".`)
    return null
  }
  if (responseFormat === 'url' && !ctx.serveConfig.publicBaseUrl) {
    rejectUrlWithoutBaseUrl(res)
    return null
  }

  try {
    assertSupportedImageOutputParams(body)
  } catch (err) {
    if (err instanceof UnsupportedImageOutputError) {
      sendError(res, 400, err.code, err.message)
      return null
    }
    throw err
  }

  const modelName = body['model'] as string
  const modelEntry = resolveModelAlias(ctx.serveConfig, modelName) ?? ctx.registry.getEntry(modelName)

  if (!modelEntry) {
    sendError(res, 404, 'model_not_found', `Model "${modelName}" is not available. Check serve.models config.`)
    return null
  }

  const endpointCategory = 'endpointCategory' in modelEntry ? modelEntry.endpointCategory : undefined
  if (endpointCategory !== 'image') {
    sendError(res, 400, 'invalid_model_type', `Model "${modelName}" does not support image generation.`)
    return null
  }

  const alias = 'alias' in modelEntry ? (modelEntry.alias as string) : modelEntry.id
  const registryEntry = ctx.registry.getEntry(alias)
  if (!registryEntry || registryEntry.state !== ctx.registry.STATES.READY) {
    sendError(res, 503, 'model_not_ready', `Model "${modelName}" is not loaded yet.`)
    return null
  }

  const sdkModelId = registryEntry.sdkModelId ?? registryEntry.id
  return { responseFormat, alias, sdkModelId }
}

/**
 * Map a known image-param error class to its HTTP 400 response. Returns true
 * when handled (caller should return), false for unknown errors (caller should
 * rethrow).
 */
function mapImageParamError (res: ServerResponse, err: unknown): boolean {
  if (err instanceof InvalidImagePromptError) {
    sendError(res, 400, 'missing_prompt', err.message)
    return true
  }
  if (err instanceof InvalidImageSizeError) {
    sendError(res, 400, 'invalid_size', err.message)
    return true
  }
  if (err instanceof InvalidImageBatchCountError) {
    sendError(res, 400, 'invalid_n', err.message)
    return true
  }
  if (err instanceof InvalidImageStrengthError) {
    sendError(res, 400, 'invalid_strength', err.message)
    return true
  }
  return false
}

interface RunImageJobOptions {
  logLabel: 'image_generate' | 'image_edit'
  errorCode: 'image_generation_error' | 'image_edit_error'
  errorVerb: 'generation' | 'editing'
  alias: string
  params: SDKDiffusionParams
  responseFormat: string
  wantsStream: boolean
}

/**
 * Run sdkDiffusion and write the JSON or SSE response. Logs a one-line
 * completion record and maps thrown SDK errors to a generic 500.
 */
async function runDiffusionAndRespond (
  res: ServerResponse,
  ctx: RouteContext,
  opts: RunImageJobOptions
): Promise<void> {
  const { logLabel, errorCode, errorVerb, alias, params, responseFormat, wantsStream } = opts
  const dims = params.width && params.height ? `${params.width}x${params.height}` : 'default'
  ctx.logger.info(`  ${logLabel} model=${alias} prompt_chars=${params.prompt.length} size=${dims} n=${params.batch_count ?? 1} response_format=${responseFormat} stream=${wantsStream}`)

  try {
    const { buffers, stats } = await sdkDiffusion({
      params,
      onProgress: (tick) => {
        ctx.logger.debug?.(`    diffusion step=${tick.step}/${tick.totalSteps} elapsed=${tick.elapsedMs}ms`)
      }
    })

    if (stats?.seed != null) {
      ctx.logger.info(`  ${logLabel} done images=${buffers.length} seed=${stats.seed} ms=${stats.totalGenerationMs ?? stats.totalWallMs ?? 0}`)
    } else {
      ctx.logger.info(`  ${logLabel} done images=${buffers.length} ms=${stats?.totalGenerationMs ?? stats?.totalWallMs ?? 0}`)
    }

    const sizeStr = buildSizeString(params.width, params.height, stats?.width, stats?.height)

    if (wantsStream) {
      sendStreamingResponse(res, buffers, sizeStr)
      return
    }

    const data = buildImageData(buffers, responseFormat, ctx.serveConfig.publicBaseUrl ?? '', ctx.ephemeralFiles)
    sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      output_format: RESPONSE_OUTPUT_FORMAT,
      ...(sizeStr ? { size: sizeStr } : {}),
      data
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`Image ${errorVerb === 'generation' ? 'generation' : 'edit'} error for "${alias}": ${message}`)
    sendError(res, 500, errorCode, `An internal error occurred during image ${errorVerb}.`)
  }
}

export async function handleImagesGenerations (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = await readBody(req)
  } catch {
    sendError(res, 400, 'invalid_json', 'Request body must be valid JSON.')
    return
  }

  const resolved = validateImageRequest(res, ctx, body)
  if (!resolved) return

  let params
  try {
    params = extractImageGenerationParams(body, resolved.sdkModelId)
  } catch (err) {
    if (mapImageParamError(res, err)) return
    throw err
  }

  logImageUnsupportedParams(body, ctx.logger)

  await runDiffusionAndRespond(res, ctx, {
    logLabel: 'image_generate',
    errorCode: 'image_generation_error',
    errorVerb: 'generation',
    alias: resolved.alias,
    params,
    responseFormat: resolved.responseFormat,
    wantsStream: body['stream'] === true
  })
}

const EDIT_IMAGE_FIELD_NAMES = new Set(['image', 'image[]'])
const MASK_FIELD_NAMES = new Set(['mask', 'mask[]'])

function collectImageFiles (files: MultipartFile[]): MultipartFile[] {
  return files.filter((f) => EDIT_IMAGE_FIELD_NAMES.has(f.fieldName))
}

function hasMaskField (files: MultipartFile[], fields: Map<string, string>): boolean {
  return files.some((f) => MASK_FIELD_NAMES.has(f.fieldName)) ||
    [...fields.keys()].some((k) => MASK_FIELD_NAMES.has(k))
}

export async function handleImagesEdits (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.includes('multipart/form-data')) {
    sendError(res, 400, 'invalid_content_type', 'Content-Type must be multipart/form-data.')
    return
  }

  let fields: Map<string, string>
  let files: MultipartFile[]

  try {
    const result = await readMultipart(req)
    fields = result.fields
    files = result.files
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`Multipart parse error: ${message}`)
    sendError(res, 400, 'invalid_multipart', 'Failed to parse multipart request.')
    return
  }

  const imageFiles = collectImageFiles(files)
  if (imageFiles.length === 0) {
    sendError(res, 400, 'missing_image', '"image" field is required.')
    return
  }

  if (hasMaskField(files, fields)) {
    sendError(res, 400, 'mask_not_supported',
      'mask inpainting is not supported by this server; the underlying diffusion ' +
      'engine has no mask channel. Resend without `mask` / `mask[]`. Until masks ' +
      'are supported, use a prompt-only edit (full-image img2img).'
    )
    return
  }

  const body = coerceMultipartFields(fields)

  const resolved = validateImageRequest(res, ctx, body)
  if (!resolved) return

  const firstImage = imageFiles[0]!.data
  const extraImageCount = imageFiles.length - 1

  let params
  try {
    params = extractImageEditParams(body, firstImage, resolved.sdkModelId)
  } catch (err) {
    if (mapImageParamError(res, err)) return
    throw err
  }

  logImageUnsupportedParams(body, ctx.logger)
  logImageEditExtraWarnings(body, { extraImageCount }, ctx.logger)

  await runDiffusionAndRespond(res, ctx, {
    logLabel: 'image_edit',
    errorCode: 'image_edit_error',
    errorVerb: 'editing',
    alias: resolved.alias,
    params,
    responseFormat: resolved.responseFormat,
    wantsStream: body['stream'] === true
  })
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
