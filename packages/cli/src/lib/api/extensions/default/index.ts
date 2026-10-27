import type { ServeExtension } from '@/lib/api/core/extensions'
import { routes } from '@/lib/api/extensions/default/routes'
import { CHAT_BATCH_FIELD_CODES } from '@/lib/api/extensions/default/schemas/chat-batch'
import { CLASSIFICATIONS_FIELD_CODES } from '@/lib/api/extensions/default/schemas/classifications'
import { MODEL_FIT_FIELD_CODES } from '@/lib/api/extensions/default/schemas/model-fit'
import { OCR_FIELD_CODES } from '@/lib/api/extensions/default/schemas/ocr'
import { SYSTEM_FIELD_CODES } from '@/lib/api/extensions/default/schemas/system'
import { TRANSLATE_FIELD_CODES } from '@/lib/api/extensions/default/schemas/translate'
import { TAG_DESCRIPTIONS } from '@/lib/api/extensions/default/tags'

const defaultExtension: ServeExtension = {
  name: 'default',
  description: 'QVAC-native REST API',
  tags: TAG_DESCRIPTIONS,
  errorCodes: {
    ...CHAT_BATCH_FIELD_CODES,
    ...SYSTEM_FIELD_CODES,
    ...MODEL_FIT_FIELD_CODES,
    ...TRANSLATE_FIELD_CODES,
    ...OCR_FIELD_CODES,
    ...CLASSIFICATIONS_FIELD_CODES
  },
  async register(app) {
    for (const route of routes) {
      await app.register(route)
    }
  }
}

export default defaultExtension
