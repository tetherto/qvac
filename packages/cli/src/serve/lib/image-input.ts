import type { FastifyRequest } from 'fastify'
import { HttpError } from '@/serve/lib/http-error'
import { resolveBinaryInput } from '@/serve/lib/binary-input'

export interface ImageFormat {
  name: string
  signature: readonly number[]
}

export const PNG: ImageFormat = {
  name: 'PNG',
  signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
}
export const JPEG: ImageFormat = { name: 'JPEG', signature: [0xff, 0xd8, 0xff] }
export const BMP: ImageFormat = { name: 'BMP', signature: [0x42, 0x4d] }

/**
 * The `image` field of a route whose engine decodes only `formats`. `read` runs
 * in a preHandler ahead of `requireModel`, so a bad image is refused without
 * loading the model; the handler then takes the bytes with `get`.
 */
export function createImageInput(formats: readonly ImageFormat[]) {
  const images = new WeakMap<FastifyRequest, Buffer>()
  const expected = listNames(formats.map((format) => format.name))

  function read(req: FastifyRequest, value: Buffer | string): void {
    const { bytes } = resolveBinaryInput(req, 'image', value)
    if (!formats.some(({ signature }) => signature.every((byte, i) => bytes[i] === byte))) {
      throw new HttpError(400, 'unsupported_image_format', `image: expected a ${expected} image.`)
    }
    images.set(req, bytes)
  }

  function get(req: FastifyRequest): Buffer {
    const bytes = images.get(req)
    if (bytes === undefined) throw new Error('image: read() did not run for this request')
    return bytes
  }

  return { read, get }
}

/** An image that passed the signature check but that the engine could not decode. */
export function undecodableImageError(engine: string): HttpError {
  return new HttpError(
    400,
    'unsupported_image_format',
    `image: the ${engine} engine could not decode it; it may be truncated or corrupt.`
  )
}

function listNames(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}
