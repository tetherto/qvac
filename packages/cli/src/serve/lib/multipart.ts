import type { FastifyRequest, preValidationAsyncHookHandler } from 'fastify'
import { HttpError } from './http-error.js'

export interface ParsedFile {
  fieldname: string
  filename: string
  mimetype: string
  buffer: Buffer
}

async function parseMultipart(req: FastifyRequest): Promise<void> {
  const fields: Record<string, string | Buffer> = {}
  const files: ParsedFile[] = []

  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer()
        files.push({
          fieldname: part.fieldname,
          filename: typeof part.filename === 'string' ? part.filename : '',
          mimetype: part.mimetype,
          buffer
        })
        // First file per fieldname wins; rest stay reachable via req.multipartFiles.
        if (!(part.fieldname in fields)) {
          fields[part.fieldname] = buffer
        }
      } else {
        const value = part.value
        if (typeof value === 'string') {
          fields[part.fieldname] = value
        } else if (value !== undefined && value !== null) {
          fields[part.fieldname] = String(value)
        }
      }
    }
  } catch (err) {
    if (err instanceof HttpError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new HttpError(400, 'invalid_multipart', `Failed to parse multipart request: ${message}`)
  }

  req.body = fields
  req.multipartFiles = files
}

export const multipartToBody: preValidationAsyncHookHandler = async function multipartToBody(req) {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.includes('multipart/form-data')) {
    throw new HttpError(400, 'invalid_content_type', 'Content-Type must be multipart/form-data.')
  }
  await parseMultipart(req)
}

export const multipartToBodyOptional: preValidationAsyncHookHandler =
  async function multipartToBodyOptional(req) {
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.includes('multipart/form-data')) return
    await parseMultipart(req)
  }
