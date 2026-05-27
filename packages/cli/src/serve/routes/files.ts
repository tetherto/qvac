import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { HttpError } from '../lib/http-error.js'
import { multipartToBody } from '../lib/multipart.js'
import { filesUploadBody, fileIdParams } from '../schemas/files.js'
import type { EphemeralFileRecord } from '../adapters/openai/ephemeral-files-store.js'

function toOpenAIFile (id: string, record: EphemeralFileRecord): Record<string, unknown> {
  return {
    object: 'file',
    id,
    bytes: record.data.length,
    created_at: Math.floor(record.createdAtMs / 1000),
    filename: record.fileName,
    purpose: record.purpose,
    status: 'uploaded'
  }
}

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post('/v1/files', {
    schema: { body: filesUploadBody, tags: ['Files'], summary: 'Upload an ephemeral file', consumes: ['multipart/form-data'] },
    preValidation: multipartToBody
  }, async (req) => {
    const ctx = app.qvac
    const body = req.body
    const fileBuf = body.file as Buffer
    const fileMeta = req.multipartFiles?.find((f) => f.fieldname === 'file')
    if (!fileMeta) {
      throw new HttpError(400, 'missing_file', '"file" field is required.')
    }
    const purpose = typeof body.purpose === 'string' && body.purpose.length > 0 ? body.purpose : 'assistants'
    const id = ctx.ephemeralFiles.put({
      data: fileBuf,
      fileName: fileMeta.filename.length > 0 ? fileMeta.filename : 'upload.bin',
      purpose
    })
    ctx.logger.info(`  files upload id=${id} bytes=${fileBuf.length} purpose=${purpose}`)
    const rec = ctx.ephemeralFiles.get(id)
    if (rec === null) {
      throw new HttpError(500, 'internal_error', 'File was uploaded but could not be retrieved.')
    }
    return toOpenAIFile(id, rec)
  })

  app.get('/v1/files', {
    schema: { tags: ['Files'], summary: 'List ephemeral files' }
  }, async () => ({
    object: 'list' as const,
    data: app.qvac.ephemeralFiles.list().map(({ id, record }) => toOpenAIFile(id, record)),
    has_more: false
  }))

  app.get('/v1/files/:id', {
    schema: { params: fileIdParams, tags: ['Files'], summary: 'Get an ephemeral file' }
  }, async (req) => {
    const id = decodeURIComponent(req.params.id)
    const record = app.qvac.ephemeralFiles.get(id)
    if (record === null) throw new HttpError(404, 'file_not_found', `File "${id}" not found.`)
    return toOpenAIFile(id, record)
  })

  app.get('/v1/files/:id/content', {
    schema: { params: fileIdParams, tags: ['Files'], summary: 'Get raw bytes of an ephemeral file' }
  }, async (req, reply) => {
    const id = decodeURIComponent(req.params.id)
    const record = app.qvac.ephemeralFiles.get(id)
    if (record === null) throw new HttpError(404, 'file_not_found', `File "${id}" not found.`)
    let cacheControl = 'private, no-store'
    if (record.expiresAtMs !== null) {
      const remainingSec = Math.max(0, Math.floor((record.expiresAtMs - Date.now()) / 1000))
      cacheControl = `private, max-age=${remainingSec}`
    }
    reply
      .type(record.contentType)
      .header('Content-Length', record.data.length.toString())
      .header('Cache-Control', cacheControl)
      .send(record.data)
  })
}

export default plugin
