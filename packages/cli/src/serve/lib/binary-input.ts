import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import { HttpError } from '@/serve/lib/http-error'

const DATA_URL_PREFIX = 'data:'
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
const OCTET_STREAM = 'application/octet-stream'

/**
 * A binary request field. Multipart sends it as a file part; JSON (or a
 * multipart text part) sends a base64 data URL or the id of an uploaded file.
 * Pair the route with `multipartToBodyOptional` and resolve the value with
 * `resolveBinaryInput`.
 */
export function binaryInput(description: string) {
  return z
    .union([z.instanceof(Buffer), z.string().min(1)])
    .describe(
      `${description} Send a multipart file part, a base64 data URL ` +
        '(`data:<type>;base64,...`), or the `id` of a file uploaded with `POST /v1/files`.'
    )
}

export interface BinaryInput {
  bytes: Buffer
  /** The type the client declared, or null when it sent none (or only `application/octet-stream`). */
  mediaType: string | null
  fileName: string | null
}

export function resolveBinaryInput(
  req: FastifyRequest,
  field: string,
  value: Buffer | string
): BinaryInput {
  const input = Buffer.isBuffer(value)
    ? fromUpload(req, field, value)
    : value.startsWith(DATA_URL_PREFIX)
      ? fromDataUrl(field, value)
      : fromFileId(req, field, value)

  if (input.bytes.length === 0) {
    throw new HttpError(400, 'empty_input', `${field}: input is empty.`)
  }
  return input
}

function fromUpload(req: FastifyRequest, field: string, bytes: Buffer): BinaryInput {
  const part = req.multipartFiles?.find((file) => file.fieldname === field)
  return {
    bytes,
    mediaType: declaredType(part?.mimetype),
    fileName: part?.filename || null
  }
}

function fromDataUrl(field: string, url: string): BinaryInput {
  const comma = url.indexOf(',')
  const header = comma === -1 ? '' : url.slice(DATA_URL_PREFIX.length, comma)
  if (!header.endsWith(';base64')) {
    throw new HttpError(
      400,
      'invalid_data_url',
      `${field}: only base64 data URLs are supported (data:<type>;base64,...).`
    )
  }
  const payload = url.slice(comma + 1)
  if (!BASE64_RE.test(payload)) {
    throw new HttpError(400, 'invalid_data_url', `${field}: data URL is not valid base64.`)
  }
  return {
    bytes: Buffer.from(payload, 'base64'),
    mediaType: declaredType(header.split(';')[0]),
    fileName: null
  }
}

function fromFileId(req: FastifyRequest, field: string, id: string): BinaryInput {
  const record = req.server.qvac.files.get(id)
  if (record === null) {
    throw new HttpError(
      400,
      'file_not_found',
      `${field}: "${id}" is neither a data URL nor the id of an uploaded file.`
    )
  }
  return {
    bytes: record.data,
    mediaType: declaredType(record.contentType),
    fileName: record.fileName || null
  }
}

function declaredType(type: string | undefined): string | null {
  const normalized = type?.trim().toLowerCase()
  return normalized && normalized !== OCTET_STREAM ? normalized : null
}
