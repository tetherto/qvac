import multipart from '@fastify/multipart'
import type { ServeExtension } from '@/serve/core/extensions'
import { parseOpenAIOptions } from '@/serve/extensions/openai/config'
import { OPENAI_FIELD_CODES } from '@/serve/extensions/openai/errors'
import { routes } from '@/serve/extensions/openai/routes'
import {
  createOpenAIState,
  openaiBanners,
  type OpenAIExtensionOptions,
  type OpenAIState
} from '@/serve/extensions/openai/state'
import { TAG_DESCRIPTIONS } from '@/serve/extensions/openai/tags'

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const MAX_UPLOAD_FILES = 10

const openaiExtension: ServeExtension = {
  name: 'openai',
  description: 'OpenAI-compatible REST API',
  tags: TAG_DESCRIPTIONS,
  errorCodes: OPENAI_FIELD_CODES,
  parseConfig: parseOpenAIOptions,
  setup: (ctx, options) => createOpenAIState(ctx, options as OpenAIExtensionOptions | undefined),
  banners: (state) => openaiBanners(state as OpenAIState),
  async register(app) {
    await app.register(multipart, {
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: MAX_UPLOAD_FILES
      }
    })

    for (const route of routes) {
      await app.register(route)
    }
  }
}

export default openaiExtension
