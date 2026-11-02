import { z } from 'zod'
import { binaryInput } from '@/serve/lib/binary-input'

// Multipart sends every text part as a string.
function formInteger() {
  return z.preprocess(
    (value) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value),
    z.number().int().positive()
  )
}

/** Mirrors the SDK's `classify()` arguments. */
export const classificationsBody = z.strictObject({
  model: z.string().min(1),
  image: binaryInput('The image to classify: PNG or JPEG.'),
  top_k: formInteger()
    .optional()
    .describe('Return only the K most likely labels. Default: every label.')
})

const classificationLabel = z.object({
  label: z.string(),
  confidence: z.number()
})

export const classificationsResult = z.object({
  object: z.literal('classification'),
  model: z.string(),
  results: z.array(classificationLabel).describe('Labels ranked by confidence, highest first.')
})

export const CLASSIFICATIONS_FIELD_CODES: Record<string, string> = {
  image: 'missing_image'
}
