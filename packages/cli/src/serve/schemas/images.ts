import { z } from 'zod'
import type { Logger } from '../../logger.js'
import type { DiffusionClientParams } from '@qvac/sdk'

export const imagesGenerationsBody = z
  .object({
    model: z.string().min(1),
    prompt: z.string().min(1),
    n: z.number().int().optional(),
    size: z.string().optional(),
    response_format: z.string().optional(),
    stream: z.boolean().optional(),
    seed: z.number().optional(),
    steps: z.number().int().optional()
  })
  .passthrough()

export const imagesEditsBody = z
  .object({
    model: z.string().min(1),
    prompt: z.string().min(1).optional(),
    image: z.instanceof(Buffer).optional(),
    // `image[]` (with literal brackets) is the OpenAI batch-edit form. Declared
    // here so a stringified value (e.g. `curl -F "image[]=junk-text"`) is
    // rejected at the validation layer with code `missing_image` instead of
    // falling through `.passthrough()` and crashing the handler at
    // `imageFiles[0]!.buffer`. The error-handler maps the instancePath
    // `image[]` → `missing_image`.
    'image[]': z.instanceof(Buffer).optional(),
    size: z.string().optional(),
    response_format: z.string().optional(),
    n: z.union([z.string(), z.number()]).optional(),
    strength: z.union([z.string(), z.number()]).optional(),
    stream: z.union([z.string(), z.boolean()]).optional()
  })
  .passthrough()
  .superRefine((body, ctx) => {
    if (!('image' in body) && !('image[]' in body)) {
      ctx.addIssue({ code: 'custom', path: ['image'], message: '"image" field is required.' })
    }
    if ('mask' in body || 'mask[]' in body) {
      ctx.addIssue({
        code: 'custom',
        path: ['mask'],
        message:
          'mask inpainting is not supported by this server; the underlying diffusion engine has no mask channel. Resend without `mask` / `mask[]`.'
      })
    }
  })

// ─── Errors ──────────────────────────────────────────────────────────

export class InvalidImageSizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidImageSizeError'
  }
}

export class InvalidImagePromptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidImagePromptError'
  }
}

export class InvalidImageBatchCountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidImageBatchCountError'
  }
}

export class UnsupportedImageOutputError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'UnsupportedImageOutputError'
    this.code = code
  }
}

export class InvalidImageStrengthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidImageStrengthError'
  }
}

// ─── Parsers / Mappers ───────────────────────────────────────────────

export type ParsedImageSize = { width: number; height: number } | { auto: true } | null

const SIZE_PATTERN = /^(\d+)x(\d+)$/

export function parseImageSize(size: unknown): ParsedImageSize {
  if (size === undefined || size === null || size === '') return null
  if (typeof size !== 'string') {
    throw new InvalidImageSizeError('"size" must be a string like "1024x1024" or "auto".')
  }
  if (size === 'auto') return { auto: true }

  const match = SIZE_PATTERN.exec(size)
  if (!match) {
    throw new InvalidImageSizeError(
      `"size" must be "WIDTHxHEIGHT" or "auto" (got ${JSON.stringify(size)}).`
    )
  }

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new InvalidImageSizeError(
      `"size" dimensions must be positive integers (got ${JSON.stringify(size)}).`
    )
  }
  if (width % 8 !== 0 || height % 8 !== 0) {
    throw new InvalidImageSizeError(
      `"size" dimensions must be multiples of 8 (got ${width}x${height}).`
    )
  }

  return { width, height }
}

export function extractImageGenerationParams(
  body: Record<string, unknown>,
  modelId: string
): DiffusionClientParams {
  const prompt = body['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new InvalidImagePromptError('"prompt" is required and must be a non-empty string.')
  }

  const params: DiffusionClientParams = { modelId, prompt }

  const parsedSize = parseImageSize(body['size'])
  if (parsedSize && 'width' in parsedSize) {
    params.width = parsedSize.width
    params.height = parsedSize.height
  }

  if (typeof body['seed'] === 'number' && Number.isInteger(body['seed'])) {
    params.seed = body['seed']
  }

  if (body['n'] !== undefined) {
    const n = body['n']
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw new InvalidImageBatchCountError(
        `"n" must be a positive integer (got ${JSON.stringify(n)}).`
      )
    }
    params.batch_count = n
  }

  return params
}

const IMAGE_ADVISORY_PARAMS = [
  'quality',
  'style',
  'moderation',
  'partial_images',
  'user',
  'input_fidelity'
] as const

export function logImageUnsupportedParams(body: Record<string, unknown>, logger: Logger): void {
  for (const param of IMAGE_ADVISORY_PARAMS) {
    if (body[param] !== undefined) {
      logger.warn(
        `Ignoring unsupported OpenAI image param: ${param}=${JSON.stringify(body[param])}`
      )
    }
  }
}

export function assertSupportedImageOutputParams(body: Record<string, unknown>): void {
  const outputFormat = body['output_format']
  if (outputFormat !== undefined && outputFormat !== null && outputFormat !== 'png') {
    throw new UnsupportedImageOutputError(
      'unsupported_output_format',
      `output_format=${JSON.stringify(outputFormat)} is not supported; this server only emits PNG. Omit the field or pass "png".`
    )
  }
  const outputCompression = body['output_compression']
  if (outputCompression !== undefined && outputCompression !== null) {
    throw new UnsupportedImageOutputError(
      'unsupported_output_compression',
      'output_compression is not supported; this server only emits PNG (lossless), where output_compression has no meaning.'
    )
  }
  const background = body['background']
  if (background !== undefined && background !== null) {
    throw new UnsupportedImageOutputError(
      'unsupported_background',
      `background=${JSON.stringify(background)} is not supported; this server has no alpha-channel control.`
    )
  }
}

export function coerceMultipartFields(fields: Map<string, string>): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (const [k, v] of fields.entries()) {
    const trimmed = v.trim()
    if (k === 'n' || k === 'seed') {
      if (/^-?\d+$/.test(trimmed)) {
        obj[k] = parseInt(trimmed, 10)
      } else {
        obj[k] = v
      }
      continue
    }
    if (k === 'stream') {
      if (trimmed === 'true' || trimmed === 'false') {
        obj[k] = trimmed === 'true'
      } else {
        obj[k] = v
      }
      continue
    }
    if (k === 'strength') {
      const f = parseFloat(trimmed)
      if (!Number.isNaN(f)) {
        obj[k] = f
      } else {
        obj[k] = v
      }
      continue
    }
    obj[k] = v
  }
  return obj
}

export function extractImageEditParams(
  body: Record<string, unknown>,
  imageBuffer: Uint8Array,
  modelId: string
): DiffusionClientParams {
  const params = extractImageGenerationParams(body, modelId)
  params.init_image = imageBuffer

  const strengthRaw = body['strength']
  if (strengthRaw !== undefined && strengthRaw !== null) {
    if (typeof strengthRaw !== 'number' || Number.isNaN(strengthRaw)) {
      throw new InvalidImageStrengthError(
        `"strength" must be a number in [0, 1] (got ${JSON.stringify(strengthRaw)}).`
      )
    }
    if (strengthRaw < 0 || strengthRaw > 1) {
      throw new InvalidImageStrengthError(`"strength" must be in [0, 1] (got ${strengthRaw}).`)
    }
    params.strength = strengthRaw
  }

  return params
}

export function logImageEditExtraWarnings(
  _body: Record<string, unknown>,
  opts: { extraImageCount: number },
  logger: Logger
): void {
  if (opts.extraImageCount > 0) {
    logger.warn(`image[] received ${opts.extraImageCount + 1} files; using only the first`)
  }
}
