import { z } from 'zod'
import { binaryInput } from '@/serve/lib/binary-input'

// Multipart sends every text part as a string.
function formBoolean() {
  return z.preprocess(
    (value) => (value === 'true' ? true : value === 'false' ? false : value),
    z.boolean()
  )
}

/** Mirrors the SDK's `ocr()` arguments. */
export const ocrBody = z.strictObject({
  model: z.string().min(1),
  image: binaryInput('The image to read: PNG, JPEG or BMP.'),
  paragraph: formBoolean()
    .optional()
    .describe('Merge nearby lines into paragraph blocks. Default false.'),
  stream: formBoolean().optional()
})

const ocrBlock = z.object({
  text: z.string(),
  bbox: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .optional()
    .describe('`[xMin, yMin, xMax, yMax]` in image pixels.'),
  confidence: z.number().optional()
})

// Loose, so a stat the SDK adds later still reaches the client through the
// response serializer.
const ocrStats = z.looseObject({
  detectionTime: z.number().optional(),
  recognitionTime: z.number().optional(),
  totalTime: z.number().optional()
})

export const ocrResult = z.object({
  object: z.literal('ocr'),
  model: z.string(),
  blocks: z.array(ocrBlock),
  stats: ocrStats.optional()
})

export const OCR_FIELD_CODES: Record<string, string> = {
  image: 'missing_image'
}
