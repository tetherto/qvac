import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { classify } from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { multipartToBodyOptional } from '@/serve/lib/multipart'
import { resolveBinaryInput } from '@/serve/lib/binary-input'
import { requireModel } from '@/serve/core/plugins/require-model'
import {
  classificationsBody,
  classificationsResult
} from '@/serve/extensions/default/schemas/classifications'

type ClassificationsResult = z.infer<typeof classificationsResult>

// The formats the classification addon decodes; it tells them apart by these signatures.
const IMAGE_SIGNATURES: readonly (readonly number[])[] = [
  [0x89, 0x50, 0x4e, 0x47],
  [0xff, 0xd8, 0xff]
]

// Filled before the model is required, so a bad image is refused without loading it.
const images = new WeakMap<FastifyRequest, Buffer>()

const description = `
Classify an image with a configured classification model, backed by the SDK's
\`classify()\`.

\`model\` names a \`serve.models\` alias whose endpoint category is
\`classification\`. An alias without \`src\` loads the addon's bundled
MobileNetV3-Small, whose labels are \`food\`, \`report\` and \`other\`.

Send the request as JSON or \`multipart/form-data\`. \`image\` is a PNG or JPEG:
a multipart file part, a base64 data URL, or the \`id\` of a file uploaded with
\`POST /v1/files\`. \`top_k\` keeps only the K most likely labels.

\`results\` ranks the labels by \`confidence\`, highest first.

**Error codes:** \`400\` \`missing_model\`, \`missing_image\`, \`empty_input\`,
\`invalid_data_url\`, \`file_not_found\`, \`unsupported_image_format\`,
\`invalid_model_type\`, \`invalid_multipart\`, \`invalid_request\`; \`404\`
\`model_not_found\`; \`413\` \`request_too_large\`; \`503\` \`model_not_loaded\`,
\`model_not_ready\`, \`model_load_failed\`, \`model_load_timeout\`.
`.trim()

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/qvac/v1/classifications',
    {
      schema: {
        body: classificationsBody,
        response: { 200: classificationsResult },
        tags: ['Classification'],
        summary: 'Classify an image',
        description,
        consumes: ['application/json', 'multipart/form-data']
      },
      preValidation: multipartToBodyOptional,
      preHandler: [
        // lunte-disable-next-line require-await
        async function (req) {
          images.set(req, imageBytes(req, req.body.image))
        },
        requireModel('classification')
      ]
    },
    async (req): Promise<ClassificationsResult> => {
      const { top_k: topK } = req.body
      const { sdkModelId, alias } = req.qvacModel!
      const bytes = images.get(req)!

      app.qvac.logger.info(`  classify model=${alias} bytes=${bytes.length}`)

      const results = await classify({
        modelId: sdkModelId,
        image: bytes,
        ...(topK !== undefined ? { topK } : {})
      })
      return { object: 'classification', model: alias, results }
    }
  )
}

function imageBytes(req: FastifyRequest, value: Buffer | string): Buffer {
  const { bytes } = resolveBinaryInput(req, 'image', value)
  if (!IMAGE_SIGNATURES.some((sig) => sig.every((byte, i) => bytes[i] === byte))) {
    throw new HttpError(400, 'unsupported_image_format', 'image: expected a PNG or JPEG image.')
  }
  return bytes
}

export default plugin
