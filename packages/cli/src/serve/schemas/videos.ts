import { z } from 'zod'
import type { VideoClientParams } from '@qvac/sdk'

// ─── Errors ──────────────────────────────────────────────────────────

export class InvalidVideoStrengthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidVideoStrengthError'
  }
}

// ─── Constants ───────────────────────────────────────────────────────

const SIZE_PATTERN = /^(\d+)x(\d+)$/
const POSITIVE_INT_STRING = /^\d+$/
const DEFAULT_FPS = 16

// ─── Zod schemas ─────────────────────────────────────────────────────

export const videosCreateBody = z
  .object({
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Model alias declared under `serve.models`. OpenAI SDK sends `model: "sora-2"` by default.'
      ),
    prompt: z.string().min(1).max(32000).describe('Text prompt. 1..32000 characters.'),
    seconds: z
      .string()
      .regex(
        POSITIVE_INT_STRING,
        '"seconds" must be a positive integer string (OpenAI accepts "4" | "8" | "12").'
      )
      .optional()
      .describe(
        'Target duration in seconds, as a string. Mapped to `video_frames = nearest_4k+1(seconds * fps)`.'
      ),
    size: z
      .string()
      .superRefine((raw, ctx) => {
        const match = SIZE_PATTERN.exec(raw)
        if (!match) {
          ctx.addIssue({
            code: 'custom',
            message: `"size" must be "WIDTHxHEIGHT" (got ${JSON.stringify(raw)}).`
          })
          return
        }
        const width = Number(match[1])
        const height = Number(match[2])
        if (width <= 0 || height <= 0) {
          ctx.addIssue({
            code: 'custom',
            message: `"size" dimensions must be positive (got ${JSON.stringify(raw)}).`
          })
          return
        }
        if (width % 16 !== 0 || height % 16 !== 0) {
          ctx.addIssue({
            code: 'custom',
            message: `"size" dimensions must be multiples of 16 (got ${width}x${height}).`
          })
        }
      })
      .optional()
      .describe(
        '"WIDTHxHEIGHT" with W,H multiples of 16. Accepts OpenAI\'s 4-value enum plus any sized WxH.'
      ),
    fps: z.coerce
      .number()
      .positive()
      .max(120)
      .optional()
      .describe('QVAC extension. 0 < fps ≤ 120, default 16.'),
    steps: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe('QVAC extension. Diffusion sampler step count.'),
    seed: z.coerce
      .number()
      .int()
      .optional()
      .describe('QVAC extension. Random seed; SDK picks one when omitted.'),
    negative_prompt: z
      .string()
      .optional()
      .describe('QVAC extension. Negative prompt for the diffusion sampler.'),
    cfg_scale: z.coerce
      .number()
      .positive()
      .optional()
      .describe('QVAC extension. Classifier-free guidance scale (Wan range 5-8).'),
    flow_shift: z.coerce
      .number()
      .optional()
      .describe(
        'QVAC extension. Flow-matching shift. Wan 2.1 T2V needs `flow_shift: 3.0` for visible motion.'
      ),
    input_reference: z
      .union([
        z.instanceof(Buffer),
        z
          .object({
            image_url: z
              .string()
              .optional()
              .describe(
                'Base64 data URI (`data:image/...;base64,...`) or HTTP(S) URL of the reference image.'
              ),
            file_id: z
              .string()
              .optional()
              .describe('ID of a file previously uploaded via POST /v1/files.')
          })
          .refine((ref) => ref.image_url !== undefined || ref.file_id !== undefined, {
            message: 'input_reference must contain either image_url or file_id.'
          })
      ])
      .optional()
      .describe(
        'OpenAI img2vid. Provide the reference image as a multipart file field (OpenAI SDK `Uploadable`), ' +
          'via `image_url` (data URI or HTTP URL), or via `file_id` (file uploaded via POST /v1/files). ' +
          'When present the job runs in img2vid mode; omit for txt2vid.'
      ),
    strength: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        'QVAC extension. img2vid denoise strength [0, 1]. Only meaningful when `input_reference` is provided.'
      )
  })
  .passthrough()

export type VideosCreateBody = z.infer<typeof videosCreateBody>

export const videoErrorObject = z
  .object({
    code: z.string(),
    message: z.string()
  })
  .nullable()

export const videoResource = z.object({
  id: z.string(),
  object: z.literal('video'),
  model: z.string(),
  status: z.enum(['queued', 'in_progress', 'completed', 'failed']),
  progress: z.number().int().min(0).max(100),
  created_at: z.number().int(),
  completed_at: z.number().int().nullable(),
  expires_at: z.number().int().nullable(),
  prompt: z.string().nullable(),
  size: z.string(),
  seconds: z.string(),
  remixed_from_video_id: z.null(),
  error: videoErrorObject
})

export const videoListResource = z.object({
  object: z.literal('list'),
  data: z.array(videoResource),
  first_id: z.string().nullable(),
  last_id: z.string().nullable(),
  has_more: z.boolean()
})

export const deletedVideoResource = z.object({
  id: z.string(),
  object: z.literal('video.deleted'),
  deleted: z.literal(true)
})

export const videosListQuery = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  after: z.string().optional()
})

export const videoContentQuery = z.object({
  variant: z
    .string()
    .optional()
    .describe(
      'Asset variant. Only "video" is supported; "thumbnail" and "spritesheet" return ' +
        '501 unsupported_variant because the server does not render them.'
    ),
  format: z
    .enum(['mp4', 'avi'])
    .optional()
    .describe(
      'QVAC extension. Force the output container regardless of server defaults. ' +
        'Omit to receive video/mp4 when ffmpeg is on PATH, video/avi otherwise.'
    )
})

export const videoIdParam = z.object({
  id: z.string().min(1)
})

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Rounds `value` to the nearest integer of the form (4*k + 1) with k >= 1
 * (so the result is one of 5, 9, 13, 17, ...). This is the constraint the
 * sdcpp video addon imposes on `video_frames`.
 */
export function nearestVideoFrameCount(value: number): number {
  if (!Number.isFinite(value)) return 5
  const k = Math.max(1, Math.round((value - 1) / 4))
  return 4 * k + 1
}

/**
 * Builds the SDK-shaped `VideoClientParams` from an already-validated body.
 * Pure mapping — Zod has done all the input shape checks.
 */
function parseSizeFields(size: string): { width: number; height: number } {
  const match = SIZE_PATTERN.exec(size)!
  return { width: Number(match[1]), height: Number(match[2]) }
}

function videoFramesFor(seconds: string, fps: number | undefined): number {
  return nearestVideoFrameCount(Number(seconds) * (fps ?? DEFAULT_FPS))
}

// Body fields that map 1:1 onto VideoClientParams. Listed once so the
// extractor doesn't repeat itself per field.
const DIRECT_PARAM_KEYS = [
  'fps',
  'seed',
  'steps',
  'negative_prompt',
  'cfg_scale',
  'flow_shift'
] as const

function coerceStrength(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = typeof raw === 'string' ? parseFloat(raw) : raw
  if (Number.isNaN(value)) {
    throw new InvalidVideoStrengthError(
      `"strength" must be a number in [0, 1] (got ${JSON.stringify(raw)}).`
    )
  }
  if (value < 0 || value > 1) {
    throw new InvalidVideoStrengthError(`"strength" must be in [0, 1] (got ${value}).`)
  }
  return value
}

export function extractVideoCreateParams(
  body: VideosCreateBody,
  initImage: Uint8Array | undefined,
  modelId: string
): VideoClientParams {
  const direct: Record<string, unknown> = {}
  for (const key of DIRECT_PARAM_KEYS) {
    if (body[key] !== undefined) direct[key] = body[key]
  }
  const base = {
    modelId,
    prompt: body.prompt,
    ...direct,
    ...(body.size !== undefined ? parseSizeFields(body.size) : {}),
    ...(body.seconds !== undefined ? { video_frames: videoFramesFor(body.seconds, body.fps) } : {})
  }
  if (initImage !== undefined) {
    const strength = coerceStrength(body.strength as string | number | undefined)
    return {
      ...base,
      mode: 'img2vid' as const,
      init_image: initImage,
      ...(strength !== undefined ? { strength } : {})
    } as unknown as VideoClientParams
  }
  return { ...base, mode: 'txt2vid' } as unknown as VideoClientParams
}

export { DEFAULT_FPS }
