import { z } from 'zod'
import { binaryInput } from '@/serve/lib/binary-input'

// Each pass multiplies both sides by the model's scale (4 for the ESRGAN x4 models).
export const MAX_UPSCALE_REPEATS = 4

/** Mirrors the SDK's `upscale()` arguments. */
export const upscaleBody = z.strictObject({
  model: z.string().min(1),
  image: binaryInput('The image to upscale: PNG or JPEG.'),
  repeats: z
    // Multipart sends every text part as a string.
    .preprocess(
      (value) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value),
      z.number().int().min(1).max(MAX_UPSCALE_REPEATS)
    )
    .optional()
    .describe(
      `Upscale passes to run, 1 to ${MAX_UPSCALE_REPEATS}. Each pass multiplies both sides by ` +
        "the model's scale; only the final image is returned. Default 1."
    )
})

export const UPSCALE_FIELD_CODES: Record<string, string> = {
  image: 'missing_image',
  repeats: 'invalid_repeats'
}
