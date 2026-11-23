import type { z } from 'zod'

/** Raw RGB dimensions as they appear on image requests. All three or none. */
export interface RawRgbDimensions {
  width?: number | undefined
  height?: number | undefined
  channels?: 3 | undefined
}

/** Rejects a request that sets only some of width, height and channels. */
export function validateRawRgbDimensions(input: RawRgbDimensions, ctx: z.RefinementCtx) {
  const present = [input.width, input.height, input.channels].filter(
    (value) => value !== undefined
  ).length
  if (present !== 0 && present !== 3) {
    ctx.addIssue({
      code: 'custom',
      path: ['width'],
      message: 'Raw RGB image requires width, height and channels together'
    })
  }
}

/** Decoded byte length of a padded base64 string, without decoding it. */
export function base64ByteLength(value: string) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

/** The raw RGB dimensions when all three are set, or undefined for JPEG/PNG. */
export function rawRgbDimensions(input: RawRgbDimensions) {
  const { width, height, channels } = input
  return width !== undefined && height !== undefined && channels !== undefined
    ? { width, height, channels }
    : undefined
}

/** The packed RGB byte count `dimensions` describe, or undefined for JPEG/PNG. */
export function rawRgbByteLength(dimensions: RawRgbDimensions) {
  const rgb = rawRgbDimensions(dimensions)
  return rgb === undefined ? undefined : rgb.width * rgb.height * rgb.channels
}
