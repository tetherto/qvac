import { z } from 'zod'
import { base64ByteLength, rawRgbByteLength, validateRawRgbDimensions } from '@/schemas/raw-rgb'
import { ggmlModelConfigShape } from '@/schemas/ggml-model-config'
import { base64String } from '@/schemas/base64'

export const imageEmbeddingConfigSchema = z.object({ ...ggmlModelConfigShape })

const imageFields = {
  width: z
    .number()
    .int()
    .positive()
    .max(16384)
    .optional()
    .describe(
      'Packed RGB width in pixels. Supply with height and channels, or omit all three for JPEG/PNG.'
    ),
  height: z
    .number()
    .int()
    .positive()
    .max(16384)
    .optional()
    .describe('Packed RGB height in pixels, from 1 to 16384.'),
  channels: z.literal(3).optional().describe('Packed RGB channel count. Must be 3.')
}

export const imageEmbeddingInputSchema = z
  .object({
    ...imageFields,
    image: base64String().min(1).describe('JPEG/PNG bytes, or packed RGB bytes, encoded as base64.')
  })
  .superRefine(validateRawRgbDimensions)
  .superRefine((input, ctx) => {
    // Checked on the encoded string so the worker rejects bad RGB input before queueing or decoding.
    const expected = rawRgbByteLength(input)
    if (expected !== undefined && base64ByteLength(input.image) !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['image'],
        message: 'Raw RGB image byte length must equal width * height * channels'
      })
    }
  })

export const imageEmbeddingClientInputSchema = z
  .object({
    ...imageFields,
    image: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0, 'Image cannot be empty')
  })
  .superRefine(validateRawRgbDimensions)
  .superRefine((input, ctx) => {
    const expected = rawRgbByteLength(input)
    if (expected !== undefined && input.image.byteLength !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['image'],
        message: 'Raw RGB image byte length must equal width * height * channels'
      })
    }
  })

export const imageEmbeddingStatsSchema = z.object({
  totalTime: z.number().optional().describe('Native embedding time in milliseconds.'),
  backendId: z
    .number()
    .int()
    .optional()
    .describe('Native backend ID: CPU=0, Metal=1, CUDA=2, Vulkan=3, OpenCL=4, other=99.'),
  cpuFallbackNodes: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Number of graph nodes scheduled on CPU fallback.'),
  weightBytes: z.number().nonnegative().optional().describe('Allocated model weight bytes.')
})

export const imageEmbeddingSchema = z
  .array(z.number())
  .length(8448)
  .describe(
    'MegaLoc descriptor with 8448 L2-normalized values. Compare descriptors with a dot product for cosine similarity.'
  )

export type ImageEmbeddingConfig = z.infer<typeof imageEmbeddingConfigSchema>
export type ImageEmbeddingStats = z.infer<typeof imageEmbeddingStatsSchema>
