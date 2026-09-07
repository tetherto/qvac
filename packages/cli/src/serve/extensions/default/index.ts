import type { ServeExtension } from '@/serve/core/extensions'
import { routes } from '@/serve/extensions/default/routes'
import { TRANSLATE_FIELD_CODES } from '@/serve/extensions/default/schemas/translate'
import { TAG_DESCRIPTIONS } from '@/serve/extensions/default/tags'

const defaultExtension: ServeExtension = {
  name: 'default',
  description: 'QVAC-native REST API',
  tags: TAG_DESCRIPTIONS,
  errorCodes: TRANSLATE_FIELD_CODES,
  async register(app) {
    for (const route of routes) {
      await app.register(route)
    }
  }
}

export default defaultExtension
