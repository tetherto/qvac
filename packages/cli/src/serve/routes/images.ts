import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyReply } from 'fastify'
import { diffusion } from '@qvac/sdk'
import type { DiffusionClientParams } from '@qvac/sdk'
import { HttpError } from '../lib/http-error.js'
import { initSSE, sendSSE, endSSE } from '../lib/sse.js'
import { multipartToBody } from '../lib/multipart.js'
import { requireModel } from '../plugins/require-model.js'
import {
  imagesGenerationsBody,
  imagesEditsBody,
  extractImageGenerationParams,
  extractImageEditParams,
  logImageUnsupportedParams,
  logImageEditExtraWarnings,
  assertSupportedImageOutputParams,
  coerceMultipartFields,
  InvalidImagePromptError,
  InvalidImageSizeError,
  InvalidImageBatchCountError,
  InvalidImageStrengthError,
  UnsupportedImageOutputError
} from '../schemas/images.js'
import type { EphemeralFilesStore } from '../adapters/openai/ephemeral-files-store.js'
import type { QvacContext } from '../lib/types.js'

const SUPPORTED_RESPONSE_FORMATS = new Set(['b64_json', 'url'])
const RESPONSE_OUTPUT_FORMAT = 'png' as const
const RESPONSE_CONTENT_TYPE = 'image/png' as const

function rejectIfUrlWithoutPublicBaseUrl (responseFormat: string, publicBaseUrl: string | null): void {
  if (responseFormat === 'url' && !publicBaseUrl) {
    throw new HttpError(
      400,
      'unsupported_response_format',
      'response_format="url" requires the server to be started with --public-base-url ' +
      '(or `serve.publicBaseUrl` in the config). This deployment has not configured a ' +
      'public origin, so it cannot mint downloadable URLs. Use response_format="b64_json" instead.'
    )
  }
}

function assertResponseFormat (raw: unknown): string {
  const responseFormat = (typeof raw === 'string' ? raw : undefined) ?? 'b64_json'
  if (!SUPPORTED_RESPONSE_FORMATS.has(responseFormat)) {
    throw new HttpError(400, 'invalid_response_format', `Unknown response_format "${responseFormat}". Use "b64_json" or "url".`)
  }
  return responseFormat
}

function mapImageParamError (err: unknown): never {
  if (err instanceof InvalidImagePromptError) throw new HttpError(400, 'missing_prompt', err.message)
  if (err instanceof InvalidImageSizeError) throw new HttpError(400, 'invalid_size', err.message)
  if (err instanceof InvalidImageBatchCountError) throw new HttpError(400, 'invalid_n', err.message)
  if (err instanceof InvalidImageStrengthError) throw new HttpError(400, 'invalid_strength', err.message)
  throw err
}

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

function buildSizeString (paramW: number | undefined, paramH: number | undefined, statsW: number | undefined, statsH: number | undefined): string | null {
  const w = statsW ?? paramW
  const h = statsH ?? paramH
  if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) return `${w}x${h}`
  return null
}

function sendStreamingResponse (reply: FastifyReply, buffers: Uint8Array[], sizeStr: string | null): void {
  initSSE(reply)
  const raw = reply.raw
  const createdAt = Math.floor(Date.now() / 1000)
  for (const buf of buffers) {
    sendSSE(raw, {
      type: 'image_generation.completed',
      created_at: createdAt,
      output_format: RESPONSE_OUTPUT_FORMAT,
      ...(sizeStr ? { size: sizeStr } : {}),
      b64_json: Buffer.from(buf).toString('base64')
    })
  }
  endSSE(raw)
}

interface RunOptions {
  logLabel: 'image_generate' | 'image_edit'
  errorVerb: 'generation' | 'editing'
  alias: string
  params: DiffusionClientParams
  responseFormat: string
  wantsStream: boolean
}

async function runAndRespond (
  reply: FastifyReply,
  ctx: QvacContext,
  opts: RunOptions
): Promise<void> {
  const { logLabel, alias, params, responseFormat, wantsStream } = opts
  const dims = params.width && params.height ? `${params.width}x${params.height}` : 'default'
  ctx.logger.info(
    `  ${logLabel} model=${alias} prompt_chars=${params.prompt.length} size=${dims} ` +
    `n=${params.batch_count ?? 1} response_format=${responseFormat} stream=${wantsStream}`
  )

  const result = diffusion(params)
  const drainProgress = async (): Promise<void> => {
    try {
      for await (const tick of result.progressStream) {
        ctx.logger.debug?.(`    diffusion step=${tick.step}/${tick.totalSteps} elapsed=${tick.elapsedMs}ms`)
      }
    } catch {
      // outputs/stats below surface the real error
    }
  }

  const [buffers, stats] = await Promise.all([
    result.outputs,
    result.stats,
    drainProgress()
  ])

  if (stats?.seed != null) {
    ctx.logger.info(`  ${logLabel} done images=${buffers.length} seed=${stats.seed} ms=${stats.totalGenerationMs ?? stats.totalWallMs ?? 0}`)
  } else {
    ctx.logger.info(`  ${logLabel} done images=${buffers.length} ms=${stats?.totalGenerationMs ?? stats?.totalWallMs ?? 0}`)
  }

  const sizeStr = buildSizeString(params.width, params.height, stats?.width, stats?.height)

  if (wantsStream) {
    sendStreamingResponse(reply, buffers, sizeStr)
    return
  }

  const data = buildImageData(buffers, responseFormat, ctx.serveConfig.publicBaseUrl ?? '', ctx.ephemeralFiles)
  reply.send({
    created: Math.floor(Date.now() / 1000),
    output_format: RESPONSE_OUTPUT_FORMAT,
    ...(sizeStr ? { size: sizeStr } : {}),
    data
  })
}

const EDIT_IMAGE_FIELD_NAMES = new Set(['image', 'image[]'])

const descriptions = {
  generate: `
Generate one or more images from a text prompt via the Stable Diffusion-cpp backend.

**Output**: PNG only. \`output_format=jpeg\`/\`webp\` are rejected with
\`unsupported_output_format\` (the server has no JPEG encoder); \`output_compression\`
and \`background\` are similarly rejected (no alpha-channel control). Only
\`response_format=b64_json\` (default) or \`url\` are accepted.

**\`response_format=url\`** requires the server to be started with
\`--public-base-url <origin>\` so URLs can resolve back to \`/v1/files/{id}/content\`.
Without it, the request is rejected with \`unsupported_response_format\`.

**Streaming**: pass \`stream: true\` to receive one
\`image_generation.completed\` SSE event per generated image, then \`[DONE]\`.
Intermediate \`partial_image\` events are not emitted (the underlying engine
streams step ticks, not image bytes).

**Validation order**: schema → model resolution (\`model_not_found\` /
\`invalid_model_type\` / \`model_not_ready\`) → param assertions
(\`unsupported_output_format\`, \`invalid_size\`, \`invalid_n\`, etc.).
`.trim(),
  edit: `
Edit an input image conditioned on a text prompt (img2img) via Stable Diffusion-cpp.

**Multipart body**. Required fields: \`model\`, \`image\` (or \`image[]\`).
Optional: \`prompt\`, \`size\`, \`response_format\`, \`n\`, \`strength\`, \`stream\`.

**Mask inpainting is not supported.** Sending a \`mask\` or \`mask[]\` field
returns 400 \`mask_not_supported\` — the underlying diffusion engine has no mask
channel. Use a prompt-only edit (full-image img2img) instead.

**Multiple images via \`image[]\`** are accepted but only the first is used;
the rest produce a warning log line.

Same output / \`response_format=url\` / streaming caveats as
\`POST /v1/images/generations\`.
`.trim()
}

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post('/v1/images/generations', {
    schema: {
      body: imagesGenerationsBody,
      tags: ['Images'],
      summary: 'Image generation',
      description: descriptions.generate
    },
    preHandler: requireModel('image')
  }, async (req, reply) => {
    const body = req.body
    const responseFormat = assertResponseFormat(body.response_format)
    rejectIfUrlWithoutPublicBaseUrl(responseFormat, app.qvac.serveConfig.publicBaseUrl)

    try {
      assertSupportedImageOutputParams(body as Record<string, unknown>)
    } catch (err) {
      if (err instanceof UnsupportedImageOutputError) throw new HttpError(400, err.code, err.message)
      throw err
    }

    let params: DiffusionClientParams
    try {
      params = extractImageGenerationParams(body as Record<string, unknown>, req.qvacModel!.sdkModelId)
    } catch (err) { mapImageParamError(err) }

    logImageUnsupportedParams(body as Record<string, unknown>, app.qvac.logger)

    await runAndRespond(reply, app.qvac, {
      logLabel: 'image_generate',
      errorVerb: 'generation',
      alias: req.qvacModel!.alias,
      params,
      responseFormat,
      wantsStream: body.stream === true
    })
  })

  app.post('/v1/images/edits', {
    schema: {
      body: imagesEditsBody,
      tags: ['Images'],
      summary: 'Image editing (img2img)',
      description: descriptions.edit,
      consumes: ['multipart/form-data']
    },
    preValidation: multipartToBody,
    preHandler: requireModel('image')
  }, async (req, reply) => {
    const body = req.body
    const imageFiles = (req.multipartFiles ?? []).filter((f) => EDIT_IMAGE_FIELD_NAMES.has(f.fieldname))
    const coerced = coerceMultipartFields(toFieldMap(body))
    const responseFormat = assertResponseFormat(coerced['response_format'])
    rejectIfUrlWithoutPublicBaseUrl(responseFormat, app.qvac.serveConfig.publicBaseUrl)

    try {
      assertSupportedImageOutputParams(coerced)
    } catch (err) {
      if (err instanceof UnsupportedImageOutputError) throw new HttpError(400, err.code, err.message)
      throw err
    }

    const firstImage = imageFiles[0]!.buffer
    const extraImageCount = imageFiles.length - 1

    let params: DiffusionClientParams
    try {
      params = extractImageEditParams(coerced, firstImage, req.qvacModel!.sdkModelId)
    } catch (err) { mapImageParamError(err) }

    logImageUnsupportedParams(coerced, app.qvac.logger)
    logImageEditExtraWarnings(coerced, { extraImageCount }, app.qvac.logger)

    await runAndRespond(reply, app.qvac, {
      logLabel: 'image_edit',
      errorVerb: 'editing',
      alias: req.qvacModel!.alias,
      params,
      responseFormat,
      wantsStream: coerced['stream'] === true
    })
  })
}

function toFieldMap (body: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>()
  for (const [k, v] of Object.entries(body)) {
    if (Buffer.isBuffer(v)) continue
    if (typeof v === 'string') map.set(k, v)
    else if (v !== undefined && v !== null) map.set(k, String(v))
  }
  return map
}

export default plugin
