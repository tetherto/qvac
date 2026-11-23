import { z } from 'zod'
import { trackedRequestSchema } from '@/schemas/request-base'
import { ggmlModelConfigShape } from '@/schemas/ggml-model-config'
import {
  base64ByteLength,
  rawRgbByteLength,
  validateRawRgbDimensions,
  type RawRgbDimensions
} from '@/schemas/raw-rgb'
import {
  base64ToOwnedBytes,
  typedArrayToBase64,
  type BufferFromArrayBuffer,
  type BufferFromBase64
} from '@/utils/encoding'

/** Smallest and largest side BridgeDepth accepts, in pixels. */
export const STEREO_DEPTH_MIN_SIDE = 32
export const STEREO_DEPTH_MAX_SIDE = 4096

export const stereoDepthConfigSchema = z.object({ ...ggmlModelConfigShape })

const side = (name: 'width' | 'height') =>
  z
    .number()
    .int()
    .min(STEREO_DEPTH_MIN_SIDE)
    .max(STEREO_DEPTH_MAX_SIDE)
    .optional()
    .describe(
      `Packed RGB ${name} of both views in pixels, from ${STEREO_DEPTH_MIN_SIDE} to ${STEREO_DEPTH_MAX_SIDE}. ` +
        'Supply width, height and channels together for raw RGB, or omit all three for JPEG/PNG.'
    )

const dimensionFields = {
  width: side('width'),
  height: side('height'),
  channels: z.literal(3).optional().describe('Packed RGB channel count. Must be 3.')
}

const modelId = z.string().min(1).describe('Loaded `ggml-stereo-depth` model.')

const viewDescription = (view: 'left' | 'right') =>
  `Rectified ${view} view: JPEG/PNG bytes, or packed RGB bytes, encoded as base64. ` +
  'Both views must have the same size.'

function checkRawRgbLength(
  input: RawRgbDimensions,
  lengths: { left: number; right: number },
  ctx: z.RefinementCtx
) {
  const expected = rawRgbByteLength(input)
  if (expected === undefined) return
  for (const view of ['left', 'right'] as const) {
    if (lengths[view] !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: [view],
        message: 'Raw RGB image byte length must equal width * height * channels'
      })
    }
  }
}

const wireFields = {
  modelId,
  left: z.base64().min(1).describe(viewDescription('left')),
  right: z.base64().min(1).describe(viewDescription('right')),
  ...dimensionFields
}

// The byte length is checked on the encoded strings so the worker rejects bad
// RGB input before queueing or decoding it.
export const estimateDisparityRequestSchema = z
  .object({
    ...wireFields,
    type: z.literal('estimateDisparity')
  })
  .extend(trackedRequestSchema.shape)
  .superRefine(validateRawRgbDimensions)
  .superRefine((input, ctx) =>
    checkRawRgbLength(
      input,
      { left: base64ByteLength(input.left), right: base64ByteLength(input.right) },
      ctx
    )
  )

const clientView = (view: 'left' | 'right') =>
  z
    .instanceof(Uint8Array)
    .refine((value) => value.byteLength > 0, 'Image cannot be empty')
    .describe(
      `Rectified ${view} view: JPEG/PNG bytes, or packed RGB bytes. Both views must have the same size.`
    )

export const estimateDisparityClientParamsSchema = z
  .object({
    modelId,
    left: clientView('left'),
    right: clientView('right'),
    ...dimensionFields
  })
  .superRefine(validateRawRgbDimensions)
  .superRefine((input, ctx) =>
    checkRawRgbLength(input, { left: input.left.byteLength, right: input.right.byteLength }, ctx)
  )

export const stereoDepthStatsSchema = z.object({
  totalTime: z.number().optional().describe('Native inference time in milliseconds.'),
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
    .describe(
      'Graph nodes the scheduler placed on the CPU while a GPU was selected. 0 on Metal, CUDA and Vulkan.'
    ),
  weightBytes: z.number().nonnegative().optional().describe('Allocated model weight bytes.')
})

export const estimateDisparityResponseSchema = z
  .object({
    type: z.literal('estimateDisparity'),
    width: z.number().int().positive().describe('Disparity map width, equal to the input width.'),
    height: z
      .number()
      .int()
      .positive()
      .describe('Disparity map height, equal to the input height.'),
    disparity: z
      .base64()
      .describe(
        'Disparity of the left view in input pixels, row-major `[height, width]`, as base64 of ' +
          'little-endian float32 values (`width * height * 4` bytes).'
      ),
    stats: stereoDepthStatsSchema.optional()
  })
  .superRefine((response, ctx) => {
    if (base64ByteLength(response.disparity) !== response.width * response.height * 4) {
      ctx.addIssue({
        code: 'custom',
        path: ['disparity'],
        message: 'Disparity byte length must equal width * height * 4'
      })
    }
  })

export type StereoDepthConfig = z.infer<typeof stereoDepthConfigSchema>
export type StereoDepthStats = z.infer<typeof stereoDepthStatsSchema>
export type EstimateDisparityRequest = z.infer<typeof estimateDisparityRequestSchema>
export type EstimateDisparityResponse = z.infer<typeof estimateDisparityResponseSchema>
export type EstimateDisparityClientParams = z.input<typeof estimateDisparityClientParamsSchema>

export interface DisparityMap {
  /** Width of the map, equal to the input width. */
  width: number
  /** Height of the map, equal to the input height. */
  height: number
  /**
   * Disparity of the left view in input pixels, row-major `[height, width]`.
   * Depth is `focalPx * baseline / disparity` with the rig's calibration.
   */
  disparity: Float32Array
  /** Native timing and backend details. */
  stats?: StereoDepthStats
}

/** Base64 of the little-endian float32 bytes of `values`, for the wire. */
export function encodeFloat32Base64(values: Float32Array, Buffer?: BufferFromArrayBuffer): string {
  return typedArrayToBase64(values, Buffer)
}

/**
 * The float32 values a base64 `disparity` field carries. The result owns its
 * buffer, so `new Float32Array(result.buffer)` reads only these values.
 */
export function decodeFloat32Base64(value: string, Buffer?: BufferFromBase64): Float32Array {
  const bytes = base64ToOwnedBytes(value, 4, Buffer)
  return new Float32Array(bytes.buffer, 0, bytes.byteLength / 4)
}
