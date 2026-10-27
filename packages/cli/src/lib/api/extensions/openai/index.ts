import type { ServeExtension } from '@/lib/api/core/extensions'
import { parseOpenAIOptions } from '@/lib/api/extensions/openai/config'
import { OPENAI_FIELD_CODES } from '@/lib/api/extensions/openai/errors'
import { routes } from '@/lib/api/extensions/openai/routes'
import {
  createOpenAIState,
  openaiBanners,
  type OpenAIExtensionOptions,
  type OpenAIState
} from '@/lib/api/extensions/openai/state'
import { TAG_DESCRIPTIONS } from '@/lib/api/extensions/openai/tags'

const openaiExtension: ServeExtension = {
  name: 'openai',
  description: 'OpenAI-compatible REST API',
  tags: TAG_DESCRIPTIONS,
  errorCodes: OPENAI_FIELD_CODES,
  parseConfig: parseOpenAIOptions,
  setup: (ctx, options) => createOpenAIState(ctx, options as OpenAIExtensionOptions | undefined),
  banners: (state) => openaiBanners(state as OpenAIState),
  async register(app) {
    for (const route of routes) {
      await app.register(route)
    }
  }
}

export default openaiExtension
