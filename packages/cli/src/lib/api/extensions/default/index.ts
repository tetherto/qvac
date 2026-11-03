import type { ServeExtension } from '@/lib/api/core/extensions'
import { routes } from '@/lib/api/extensions/default/routes'
import { CHAT_BATCH_FIELD_CODES } from '@/lib/api/extensions/default/schemas/chat-batch'
import { CLASSIFICATIONS_FIELD_CODES } from '@/lib/api/extensions/default/schemas/classifications'
import { MODEL_FIT_FIELD_CODES } from '@/lib/api/extensions/default/schemas/model-fit'
import { MUSIC_FIELD_CODES } from '@/lib/api/extensions/default/schemas/music'
import { OCR_FIELD_CODES } from '@/lib/api/extensions/default/schemas/ocr'
import { REGISTRY_FIELD_CODES } from '@/lib/api/extensions/default/schemas/registry'
import { SYSTEM_FIELD_CODES } from '@/lib/api/extensions/default/schemas/system'
import { TRANSLATE_FIELD_CODES } from '@/lib/api/extensions/default/schemas/translate'
import { UPSCALE_FIELD_CODES } from '@/lib/api/extensions/default/schemas/upscale'
import { WORLD_FIELD_CODES } from '@/lib/api/extensions/default/schemas/world'
import { TAG_DESCRIPTIONS } from '@/lib/api/extensions/default/tags'
import { tearDownMusicJob } from '@/lib/api/extensions/default/routes/music'
import {
  createDefaultState,
  defaultBanners,
  type DefaultState
} from '@/lib/api/extensions/default/state'

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
    ...REGISTRY_FIELD_CODES,
    ...UPSCALE_FIELD_CODES,
    ...MUSIC_FIELD_CODES,
    ...WORLD_FIELD_CODES
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
