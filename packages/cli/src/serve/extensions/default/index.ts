import type { ServeExtension } from '@/serve/core/extensions'
import { routes } from '@/serve/extensions/default/routes'
import { CHAT_BATCH_FIELD_CODES } from '@/serve/extensions/default/schemas/chat-batch'
import { CLASSIFICATIONS_FIELD_CODES } from '@/serve/extensions/default/schemas/classifications'
import { MODEL_FIT_FIELD_CODES } from '@/serve/extensions/default/schemas/model-fit'
import { MUSIC_FIELD_CODES } from '@/serve/extensions/default/schemas/music'
import { OCR_FIELD_CODES } from '@/serve/extensions/default/schemas/ocr'
import { SYSTEM_FIELD_CODES } from '@/serve/extensions/default/schemas/system'
import { TRANSLATE_FIELD_CODES } from '@/serve/extensions/default/schemas/translate'
import { UPSCALE_FIELD_CODES } from '@/serve/extensions/default/schemas/upscale'
import { TAG_DESCRIPTIONS } from '@/serve/extensions/default/tags'
import { tearDownMusicJob } from '@/serve/extensions/default/routes/music'
import {
  createDefaultState,
  defaultBanners,
  type DefaultState
} from '@/serve/extensions/default/state'

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
    ...CLASSIFICATIONS_FIELD_CODES,
    ...UPSCALE_FIELD_CODES,
    ...MUSIC_FIELD_CODES
  },
  // lunte-disable-next-line require-await
  setup: async (ctx) => createDefaultState(ctx, tearDownMusicJob),
  banners: (state) => defaultBanners(state as DefaultState),
  async register(app) {
    for (const route of routes) {
      await app.register(route)
    }
  }
}

export default defaultExtension
