import { z } from 'zod'
import type { EphemeralFilesStore } from '@/serve/core/stores/ephemeral-files'

export const IMAGE_OUTPUT_FORMAT = 'png' as const
const IMAGE_CONTENT_TYPE = 'image/png' as const

export interface ImageUrlTarget {
  publicBaseUrl: string
  files: EphemeralFilesStore
}

export type ImageData = { b64_json: string } | { url: string; expires_at?: number }

export const imagesResponse = z.object({
  created: z.number().int(),
  output_format: z.literal(IMAGE_OUTPUT_FORMAT),
  size: z.string().optional().describe('`<width>x<height>` of the returned image.'),
  data: z.array(z.object({ b64_json: z.string() }))
})

export function b64ImageData(buffers: Uint8Array[]): { b64_json: string }[] {
  return buffers.map((buf) => ({ b64_json: Buffer.from(buf).toString('base64') }))
}

/** Base64 PNGs, or ephemeral `/v1/files` URLs when `urlTarget` is given. */
export function buildImageData(buffers: Uint8Array[], urlTarget?: ImageUrlTarget): ImageData[] {
  if (urlTarget === undefined) return b64ImageData(buffers)
  const { publicBaseUrl, files } = urlTarget
  return buffers.map((buf, i) => {
    const id = files.put({
      data: Buffer.from(buf),
      fileName: `image-${Date.now()}-${i}.png`,
      purpose: 'image_generation',
      contentType: IMAGE_CONTENT_TYPE
    })
    const url = `${publicBaseUrl}/v1/files/${id}/content`
    const stored = files.get(id)
    if (stored !== null && stored.expiresAtMs !== null) {
      return { url, expires_at: Math.floor(stored.expiresAtMs / 1000) }
    }
    return { url }
  })
}

export function buildSizeString(
  paramW: number | undefined,
  paramH: number | undefined,
  statsW: number | undefined,
  statsH: number | undefined
): string | null {
  const w = statsW ?? paramW
  const h = statsH ?? paramH
  if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) return `${w}x${h}`
  return null
}
