import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyRequest } from 'fastify'
import { upscale } from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { multipartToBodyOptional } from '@/serve/lib/multipart'
import { resolveBinaryInput } from '@/serve/lib/binary-input'
import { errorResponses } from '@/serve/lib/error-responses'
import {
  IMAGE_OUTPUT_FORMAT,
  b64ImageData,
  buildSizeString,
  imagesResponse
} from '@/serve/lib/image-response'
import { requireModel } from '@/serve/core/plugins/require-model'
import { MAX_UPSCALE_REPEATS, upscaleBody } from '@/serve/extensions/default/schemas/upscale'

type UpscaleParams = Parameters<typeof upscale>[0]

// The formats the ESRGAN upscaler decodes.
const IMAGE_SIGNATURES: readonly (readonly number[])[] = [
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [0xff, 0xd8, 0xff]
]

// The addon's message when a PNG or JPEG header is followed by data it cannot
// decode; the SDK passes it through with no error code.
const DECODE_FAILURE = /Failed to decode input image/

// Filled before the model is required, so a bad image is refused without loading it.
const images = new WeakMap<FastifyRequest, Buffer>()

const description = `
Upscale an image with a configured ESRGAN model, backed by the SDK's \`upscale()\`.

\`model\` names a \`serve.models\` alias whose endpoint category is \`upscale\`: an
\`sdcpp-generation\` model with \`config.mode: "upscale"\`.

Send the request as JSON or \`multipart/form-data\`. \`image\` is a PNG or JPEG: a
multipart file part, a base64 data URL, or the \`id\` of a file uploaded with
\`POST /v1/files\`. \`repeats\` runs up to ${MAX_UPSCALE_REPEATS} passes, each multiplying
both sides by the model's scale.

The response has the \`/v1/images\` shape: one PNG in \`data[0].b64_json\`, and its
\`size\`.

Upscaling cannot be cancelled: a client disconnect drops the result, but the
image is still upscaled to the end.
`.trim()

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/qvac/v1/images/upscale',
    {
      schema: {
        body: upscaleBody,
        response: {
          200: imagesResponse,
          ...errorResponses({
            400: {
              invalid_json: 'Body is not valid JSON',
              invalid_multipart: 'The multipart body cannot be parsed',
              missing_model: '`model` is missing',
              missing_image: '`image` is missing',
              empty_input: '`image` has no bytes',
              invalid_data_url: '`image` is a data URL that is not base64',
              file_not_found: '`image` is neither a data URL nor an uploaded file id',
              unsupported_image_format: '`image` is not a PNG or JPEG',
              invalid_image: '`image` has a PNG or JPEG header but cannot be decoded',
              invalid_repeats: `\`repeats\` is not an integer from 1 to ${MAX_UPSCALE_REPEATS}`,
              invalid_request: 'The body carries an unknown field',
              invalid_model_type: 'The alias is not an `upscale` model'
            },
            404: { model_not_found: 'Unknown alias' },
            413: { request_too_large: 'The upload is over the size cap' },
            503: {
              model_not_loaded: 'The model is not loaded and lazy loading is disabled',
              model_load_failed: 'The model failed to load',
              model_load_timeout: 'The model did not load in time'
            }
          })
        },
        tags: ['Upscale'],
        summary: 'Upscale an image',
        description,
        consumes: ['application/json', 'multipart/form-data']
      },
      preValidation: multipartToBodyOptional,
      preHandler: [
        // lunte-disable-next-line require-await
        async function (req) {
          images.set(req, imageBytes(req, req.body.image))
        },
        requireModel('upscale')
      ]
    },
    async (req) => {
      const { repeats } = req.body
      const { sdkModelId, alias } = req.qvacModel!
      const bytes = images.get(req)!

      app.qvac.logger.info(
        `  image_upscale model=${alias} bytes=${bytes.length} repeats=${repeats ?? 1}`
      )

      const result = upscale({
        modelId: sdkModelId,
        // Typed as bare-buffer's Buffer; the SDK only base64-encodes it.
        image: bytes as unknown as UpscaleParams['image'],
        ...(repeats !== undefined ? { repeats } : {})
      })
      const [buffers, stats] = await Promise.all([result.outputs, result.stats]).catch(
        (err: unknown) => {
          if (err instanceof Error && DECODE_FAILURE.test(err.message)) {
            throw new HttpError(400, 'invalid_image', `image: ${err.message}`)
          }
          throw err
        }
      )
      app.qvac.logger.info(`  image_upscale done ms=${stats?.upscaleMs ?? 0}`)

      const size = buildSizeString(undefined, undefined, stats?.width, stats?.height)
      return {
        created: Math.floor(Date.now() / 1000),
        output_format: IMAGE_OUTPUT_FORMAT,
        ...(size ? { size } : {}),
        data: b64ImageData(buffers)
      }
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
