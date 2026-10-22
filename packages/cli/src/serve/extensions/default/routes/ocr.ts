import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { ocr } from '@qvac/sdk'
import { randomBytes } from 'node:crypto'
import { initSSE, sendSSE, endSSE } from '@/serve/lib/sse'
import { HttpError } from '@/serve/lib/http-error'
import { multipartToBodyOptional } from '@/serve/lib/multipart'
import { resolveBinaryInput } from '@/serve/lib/binary-input'
import { requireModel } from '@/serve/core/plugins/require-model'
import { ocrBody, ocrResult } from '@/serve/extensions/default/schemas/ocr'

type OcrResult = z.infer<typeof ocrResult>
type OcrParams = Parameters<typeof ocr>[0]

interface OcrCall {
  modelId: string
  model: string
  image: Buffer
  paragraph: boolean | undefined
}

// The formats the OCR addon decodes; it tells them apart by these signatures.
const IMAGE_SIGNATURES: readonly (readonly number[])[] = [
  [0x89, 0x50, 0x4e, 0x47],
  [0xff, 0xd8, 0xff],
  [0x42, 0x4d]
]

// Filled before the model is required, so a bad image is refused without loading it.
const images = new WeakMap<FastifyRequest, Buffer>()

const description = `
Read the text in an image with a configured OCR model, backed by the SDK's \`ocr()\`.

\`model\` names a \`serve.models\` alias whose endpoint category is \`ocr\`.
That alias's \`config\` carries the pipeline and languages.

Send the request as JSON or \`multipart/form-data\`. \`image\` is a PNG, JPEG or
BMP: a multipart file part, a base64 data URL, or the \`id\` of a file uploaded
with \`POST /v1/files\`. \`paragraph: true\` merges nearby lines into paragraph
blocks.

\`blocks\` lists the recognised text in reading order. Each block carries its
\`text\`, and \`bbox\` and \`confidence\` when the engine reports them.

\`stream: true\` emits Server-Sent Events: \`ocr.chunk\` events carrying
\`blocks\` as the engine returns them, then one \`ocr.done\` with \`stats\`, then
\`data: [DONE]\`. The engine currently returns all of an image's blocks at once,
so expect a single \`ocr.chunk\`.

OCR cannot be cancelled: a client disconnect drops the result, but the image is
still read to the end.

**Error codes:** \`400\` \`missing_model\`, \`missing_image\`, \`empty_input\`,
\`invalid_data_url\`, \`file_not_found\`, \`unsupported_image_format\`,
\`invalid_model_type\`, \`invalid_multipart\`; \`404\` \`model_not_found\`;
\`413\` \`request_too_large\`; \`503\` \`model_not_loaded\`, \`model_not_ready\`,
\`model_load_failed\`, \`model_load_timeout\`.
`.trim()

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/qvac/v1/ocr',
    {
      schema: {
        body: ocrBody,
        response: { 200: ocrResult },
        tags: ['OCR'],
        summary: 'Read text from an image',
        description,
        consumes: ['application/json', 'multipart/form-data']
      },
      preValidation: multipartToBodyOptional,
      preHandler: [
        // lunte-disable-next-line require-await
        async function readImage(req) {
          images.set(req, imageBytes(req, req.body.image))
        },
        requireModel('ocr')
      ]
    },
    async (req, reply) => {
      const { paragraph, stream } = req.body
      const { sdkModelId, alias } = req.qvacModel!
      const bytes = images.get(req)!

      const call: OcrCall = { modelId: sdkModelId, model: alias, image: bytes, paragraph }
      app.qvac.logger.info(`  ocr model=${alias} bytes=${bytes.length} stream=${stream === true}`)

      if (stream === true) {
        await streamOcr(call, reply)
        return
      }
      return await readImage(call)
    }
  )
}

function imageBytes(req: FastifyRequest, value: Buffer | string): Buffer {
  const { bytes } = resolveBinaryInput(req, 'image', value)
  if (!IMAGE_SIGNATURES.some((sig) => sig.every((byte, i) => bytes[i] === byte))) {
    throw new HttpError(
      400,
      'unsupported_image_format',
      'image: expected a PNG, JPEG or BMP image.'
    )
  }
  return bytes
}

function runOcr(call: OcrCall, stream: boolean) {
  return ocr({
    modelId: call.modelId,
    // Typed as bare-buffer's Buffer; the SDK only base64-encodes it.
    image: call.image as unknown as OcrParams['image'],
    stream,
    ...(call.paragraph !== undefined ? { options: { paragraph: call.paragraph } } : {})
  })
}

async function readImage(call: OcrCall): Promise<OcrResult> {
  const result = runOcr(call, false)
  const [blocks, stats] = await Promise.all([result.blocks, result.stats])
  return {
    object: 'ocr',
    model: call.model,
    blocks,
    ...(stats !== undefined ? { stats } : {})
  }
}

async function streamOcr(call: OcrCall, reply: FastifyReply): Promise<void> {
  const { model } = call
  const result = runOcr(call, true)

  initSSE(reply)
  const raw = reply.raw
  const id = `ocr-${randomBytes(6).toString('hex')}`
  const created = Math.floor(Date.now() / 1000)

  for await (const blocks of result.blockStream) {
    sendSSE(raw, { object: 'ocr.chunk', id, created, model, blocks })
  }

  const stats = await result.stats
  sendSSE(raw, {
    object: 'ocr.done',
    id,
    created,
    model,
    ...(stats !== undefined ? { stats } : {})
  })
  endSSE(raw)
}

export default plugin
