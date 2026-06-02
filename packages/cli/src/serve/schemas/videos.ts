import { z } from 'zod'
import type { VideoClientParams } from '@qvac/sdk'

// ─── Constants ───────────────────────────────────────────────────────

const SIZE_PATTERN = /^(\d+)x(\d+)$/
const POSITIVE_INT_STRING = /^\d+$/
const DEFAULT_FPS = 16

// ─── Zod schemas ─────────────────────────────────────────────────────

export const videosCreateBody = z.object({
  model: z.string().min(1).optional().describe(
    'Model alias declared under `serve.models`. OpenAI SDK sends `model: "sora-2"` by default.'
  ),
  prompt: z.string().min(1).max(32000).describe('Text prompt. 1..32000 characters.'),
  seconds: z.string()
    .regex(POSITIVE_INT_STRING, '"seconds" must be a positive integer string (OpenAI accepts "4" | "8" | "12").')
    .optional()
    .describe('Target duration in seconds, as a string. Mapped to `video_frames = nearest_4k+1(seconds * fps)`.'),
  size: z.string()
    .superRefine((raw, ctx) => {
      const match = SIZE_PATTERN.exec(raw)
      if (!match) {
        ctx.addIssue({ code: 'custom', message: `"size" must be "WIDTHxHEIGHT" (got ${JSON.stringify(raw)}).` })
        return
      }
      const width = Number(match[1])
      const height = Number(match[2])
      if (width <= 0 || height <= 0) {
        ctx.addIssue({ code: 'custom', message: `"size" dimensions must be positive (got ${JSON.stringify(raw)}).` })
        return
      }
      if (width % 8 !== 0 || height % 8 !== 0) {
        ctx.addIssue({ code: 'custom', message: `"size" dimensions must be multiples of 8 (got ${width}x${height}).` })
      }
    })
    .optional()
    .describe('"WIDTHxHEIGHT" with W,H multiples of 8. Accepts OpenAI\'s 4-value enum plus any sized WxH.'),
  fps: z.number().positive().max(120).optional().describe('QVAC extension. 0 < fps ≤ 120, default 16.'),
  steps: z.number().int().positive().optional().describe('QVAC extension. Diffusion sampler step count.'),
  seed: z.number().int().optional().describe('QVAC extension. Random seed; SDK picks one when omitted.'),
  negative_prompt: z.string().optional().describe('QVAC extension. Negative prompt for the diffusion sampler.'),
  cfg_scale: z.number().positive().optional().describe('QVAC extension. Classifier-free guidance scale (Wan range 5-8).'),
  flow_shift: z.number().optional().describe(
    'QVAC extension. Flow-matching shift. Wan 2.1 T2V needs `flow_shift: 3.0` for visible motion.'
  ),
  input_reference: z.never({
    message: '"input_reference" (image-to-video) is not supported — the SDK exposes only text-to-video (txt2vid).'
  }).optional()
}).passthrough()

export type VideosCreateBody = z.infer<typeof videosCreateBody>

export const videoErrorObject = z.object({
  code: z.string(),
  message: z.string()
}).nullable()

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
  variant: z.string().optional().describe(
    'Asset variant. Only "video" is supported; "thumbnail" and "spritesheet" return ' +
    '501 unsupported_variant because the server does not render them.'
  ),
  format: z.enum(['mp4', 'avi']).optional().describe(
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
export function nearestVideoFrameCount (value: number): number {
  if (!Number.isFinite(value)) return 5
  const k = Math.max(1, Math.round((value - 1) / 4))
  return 4 * k + 1
}

/**
 * Builds the SDK-shaped `VideoClientParams` from an already-validated body.
 * Pure mapping — Zod has done all the input shape checks.
 */
function parseSizeFields (size: string): { width: number; height: number } {
  const match = SIZE_PATTERN.exec(size)!
  return { width: Number(match[1]), height: Number(match[2]) }
}

function videoFramesFor (seconds: string, fps: number | undefined): number {
  return nearestVideoFrameCount(Number(seconds) * (fps ?? DEFAULT_FPS))
}

// Body fields that map 1:1 onto VideoClientParams. Listed once so the
// extractor doesn't repeat itself per field.
const DIRECT_PARAM_KEYS = ['fps', 'seed', 'steps', 'negative_prompt', 'cfg_scale', 'flow_shift'] as const

export function extractVideoCreateParams (body: VideosCreateBody, modelId: string): VideoClientParams {
  const direct: Partial<VideoClientParams> = {}
  for (const key of DIRECT_PARAM_KEYS) {
    if (body[key] !== undefined) (direct as Record<string, unknown>)[key] = body[key]
  }
  return {
    modelId,
    mode: 'txt2vid',
    prompt: body.prompt,
    ...direct,
    ...(body.size !== undefined ? parseSizeFields(body.size) : {}),
    ...(body.seconds !== undefined ? { video_frames: videoFramesFor(body.seconds, body.fps) } : {})
  }
}

export { DEFAULT_FPS }
