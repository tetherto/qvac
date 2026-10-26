import type { ServeExtension } from '@/serve/core/extensions'
import { routes } from '@/serve/extensions/default/routes'
import { CHAT_BATCH_FIELD_CODES } from '@/serve/extensions/default/schemas/chat-batch'
import { MODEL_FIT_FIELD_CODES } from '@/serve/extensions/default/schemas/model-fit'
import { OCR_FIELD_CODES } from '@/serve/extensions/default/schemas/ocr'
import { SYSTEM_FIELD_CODES } from '@/serve/extensions/default/schemas/system'
import { TRANSLATE_FIELD_CODES } from '@/serve/extensions/default/schemas/translate'
import { TAG_DESCRIPTIONS } from '@/serve/extensions/default/tags'

const defaultExtension: ServeExtension = {
  name: 'default',
  description: 'QVAC-native REST API',
  tags: TAG_DESCRIPTIONS,
  errorCodes: {
    ...CHAT_BATCH_FIELD_CODES,
    ...SYSTEM_FIELD_CODES,
    ...MODEL_FIT_FIELD_CODES,
    ...TRANSLATE_FIELD_CODES,
    ...OCR_FIELD_CODES
  },
  async register(app) {
    for (const route of routes) {
      await app.register(route)
    }
  }
}

export default defaultExtension
