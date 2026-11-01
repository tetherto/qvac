import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { upscale } from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { multipartToBodyOptional } from '@/serve/lib/multipart'
import { JPEG, PNG, createImageInput } from '@/serve/lib/image-input'
import { errorResponses } from '@/serve/lib/error-responses'
import {
  IMAGE_OUTPUT_FORMAT,
  b64ImageData,
  buildSizeString,
  imagesResponse
} from '@/serve/lib/image-response'
import { requireModel } from '@/serve/core/plugins/require-model'
import { MAX_UPSCALE_REPEATS, upscaleBody } from '@/serve/extensions/default/schemas/upscale'

// The formats the ESRGAN upscaler decodes.
const image = createImageInput([PNG, JPEG])

// The addon's messages for an image it refuses; the SDK passes them through
// with no error code. Some decode failures are size limits, so TOO_LARGE is tested first.
const TOO_LARGE = /Failed to decode input image: .*exceeds|ESRGAN output exceeds/
const DECODE_FAILURE = /Failed to decode input image/

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
              image_too_large:
                '`image`, or its upscaled output, exceeds the 16,384-pixel edge or pixel-count limit',
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
          image.read(req, req.body.image)
        },
        requireModel('upscale')
      ]
    },
    async (req) => {
      const { repeats } = req.body
      const { sdkModelId, alias } = req.qvacModel!
      const bytes = image.get(req)

      app.qvac.logger.info(
        `  image_upscale model=${alias} bytes=${bytes.length} repeats=${repeats ?? 1}`
      )

      const result = upscale({
        modelId: sdkModelId,
        image: bytes,
        ...(repeats !== undefined ? { repeats } : {})
      })
      const [buffers, stats] = await Promise.all([result.outputs, result.stats]).catch(
        (err: unknown) => {
          throw toHttpError(err)
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

function toHttpError(err: unknown): unknown {
  if (!(err instanceof Error)) return err
  if (TOO_LARGE.test(err.message)) {
    return new HttpError(400, 'image_too_large', `image: ${err.message}`)
  }
  if (DECODE_FAILURE.test(err.message)) {
    return new HttpError(400, 'invalid_image', `image: ${err.message}`)
  }
  return err
}

export default plugin
