import { z } from 'zod'
import { binaryInput } from '@/serve/lib/binary-input'
import { formBoolean, formJson, formNumber } from '@/serve/lib/form-fields'

// The SDK's scene limits: each side a multiple of 32 up to 4096, and the area
// within 1920x1088. The SDK enforces them too; checking here keeps the 400 off
// the model load.
export const SCENE_DIMENSION_STEP = 32
export const MAX_SCENE_DIMENSION = 4096
export const MAX_SCENE_PIXELS = 1920 * 1088
export const MAX_SCENE_IMAGE_BYTES = 3 * 1024 * 1024

export const WALK_KEYS = ['W', 'A', 'S', 'D', 'I', 'J', 'K', 'L'] as const

function sceneDimension(axis: string, fallback: number) {
  return formNumber(
    z.number().int().positive().multipleOf(SCENE_DIMENSION_STEP).max(MAX_SCENE_DIMENSION)
  )
    .optional()
    .describe(
      `Scene ${axis} in pixels, a multiple of ${SCENE_DIMENSION_STEP} up to ` +
        `${MAX_SCENE_DIMENSION}. Default ${fallback}. width x height must stay within ` +
        `${MAX_SCENE_PIXELS} pixels (1920x1088).`
    )
}

/** Mirrors the SDK's `worldCreateScene()` arguments. */
export const worldSceneBody = z
  .strictObject({
    model: z.string().min(1),
    prompt: z
      .string()
      .min(1)
      .describe(
        'Scene prompt, encoded verbatim. The reference pipeline prefixes prompts with "| unknown | ".'
      ),
    image: binaryInput(
      `The first frame: PNG or JPEG, up to ${MAX_SCENE_IMAGE_BYTES / (1024 * 1024)} MB. It is ` +
        'cover-scaled and center-cropped to width x height.'
    ),
    width: sceneDimension('width', 832),
    height: sceneDimension('height', 480),
    returnPack: formBoolean()
      .optional()
      .describe(
        'Return the scene pack (10+ MB) base64 in `pack`. Pass a saved pack back as ' +
          '`config.sceneSrc` on the model to walk the same world after a restart. Default false.'
      )
  })
  .superRefine((body, ctx) => {
    if (body.width === undefined || body.height === undefined) return
    if (body.width * body.height > MAX_SCENE_PIXELS) {
      ctx.addIssue({
        code: 'custom',
        path: ['width'],
        message: `${body.width}x${body.height} is over the ${MAX_SCENE_PIXELS}-pixel ceiling.`
      })
    }
  })

export const worldStepBody = z.strictObject({
  keys: formJson(z.array(z.enum(WALK_KEYS)))
    .optional()
    .describe('Keys held for this block. WASD move, IJKL steer the camera. Omit to idle.'),
  stream: formBoolean()
    .optional()
    .describe('Send each frame as a server-sent event as it is decoded. Default false.')
})

export const sceneIdParams = z.strictObject({ id: z.string().min(1) })

export const worldScene = z.object({
  id: z.string(),
  object: z.literal('world.scene'),
  created: z.number().int(),
  model: z.string(),
  status: z
    .enum(['active', 'replaced'])
    .describe(
      '`replaced` once a newer scene was created on the same model, or the model reloaded.'
    ),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  scene_create_ms: z.number().optional(),
  pack: z.string().optional().describe('Base64 scene pack, when `returnPack` was set.')
})

const stepStats = z.object({
  step_ms: z.number().optional(),
  total_steps: z.number().int().optional(),
  total_frames: z.number().int().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional()
})

export const worldStep = z.object({
  object: z.literal('world.step'),
  scene_id: z.string(),
  output_format: z.enum(['png', 'jpeg']),
  data: z.array(z.object({ b64_json: z.string() })),
  stats: stepStats
})

export type WorldStepStatsResponse = z.infer<typeof stepStats>

export const WORLD_FIELD_CODES: Record<string, string> = {
  prompt: 'missing_prompt',
  image: 'missing_image',
  width: 'invalid_dimensions',
  height: 'invalid_dimensions',
  keys: 'invalid_keys'
}
