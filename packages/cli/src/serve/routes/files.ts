import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { HttpError } from '../lib/http-error.js'
import { multipartToBody } from '../lib/multipart.js'
import { filesUploadBody, fileIdParams } from '../schemas/files.js'
import type { EphemeralFileRecord } from '../adapters/openai/ephemeral-files-store.js'

function toOpenAIFile(id: string, record: EphemeralFileRecord): Record<string, unknown> {
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

const descriptions = {
  upload: `
Upload bytes into an **ephemeral in-memory store**. The returned file id can
be used immediately with \`POST /v1/vector_stores/{id}/files\` to attach the
content into a RAG workspace, at which point the file is removed from the
store. Files not attached within the configured TTL are evicted automatically.

**Not durable**: contents do not survive process restarts. There is no quota
beyond the request's body limit.

**\`purpose\`** is recorded verbatim from the multipart field; defaults to
\`"assistants"\` if omitted.
`.trim(),
  list: `
List files currently held in the ephemeral in-memory store. Files removed
by a vector-store attach or by TTL eviction do not appear.
`.trim(),
  getById: `
Fetch metadata for a single ephemeral file. 404 \`file_not_found\` if the
file has been attached/evicted or never existed.
`.trim(),
  getByIdContent: `
Stream the raw bytes of an ephemeral file with the stored \`Content-Type\`.
Used by \`/v1/images/generations\` with \`response_format=url\` to back the
minted download URLs.

**\`Cache-Control\`** is set to \`private, max-age=<remaining-ttl-seconds>\`
when the file has a TTL, otherwise \`private, no-store\`. Downstream proxies
will not serve stale bytes after the store has evicted the entry.
`.trim()
}

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/files',
    {
      schema: {
        body: filesUploadBody,
        tags: ['Files'],
        summary: 'Upload an ephemeral file',
        description: descriptions.upload,
        consumes: ['multipart/form-data']
      },
      preValidation: multipartToBody
    },
    // lunte-disable-next-line require-await
    async (req) => {
      const ctx = app.qvac
      const body = req.body
      const fileBuf = body.file as Buffer
      const fileMeta = req.multipartFiles?.find((f) => f.fieldname === 'file')
      if (!fileMeta) {
        throw new HttpError(400, 'missing_file', '"file" field is required.')
      }
      const purpose =
        typeof body.purpose === 'string' && body.purpose.length > 0 ? body.purpose : 'assistants'
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
    }
  )

  app.get(
    '/v1/files',
    {
      schema: { tags: ['Files'], summary: 'List ephemeral files', description: descriptions.list }
    },
    // lunte-disable-next-line require-await
    async () => ({
      object: 'list' as const,
      data: app.qvac.ephemeralFiles.list().map(({ id, record }) => toOpenAIFile(id, record)),
      has_more: false
    })
  )

  app.get(
    '/v1/files/:id',
    {
      schema: {
        params: fileIdParams,
        tags: ['Files'],
        summary: 'Get an ephemeral file',
        description: descriptions.getById
      }
    },
    // lunte-disable-next-line require-await
    async (req) => {
      const id = decodeURIComponent(req.params.id)
      const record = app.qvac.ephemeralFiles.get(id)
      if (record === null) throw new HttpError(404, 'file_not_found', `File "${id}" not found.`)
      return toOpenAIFile(id, record)
    }
  )

  app.get(
    '/v1/files/:id/content',
    {
      schema: {
        params: fileIdParams,
        tags: ['Files'],
        summary: 'Get raw bytes of an ephemeral file',
        description: descriptions.getByIdContent
      }
    },
    // lunte-disable-next-line require-await
    async (req, reply) => {
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
    }
  )
}

export default plugin
