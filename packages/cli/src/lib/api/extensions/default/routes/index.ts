import type { HttpPlugin } from '@/lib/http'
import chatBatch from '@/lib/api/extensions/default/routes/chat-batch'
import classifications from '@/lib/api/extensions/default/routes/classifications'
import kvCache from '@/lib/api/extensions/default/routes/kv-cache'
import modelFit from '@/lib/api/extensions/default/routes/model-fit'
import music from '@/lib/api/extensions/default/routes/music'
import ocr from '@/lib/api/extensions/default/routes/ocr'
import registry from '@/lib/api/extensions/default/routes/registry'
import runtime from '@/lib/api/extensions/default/routes/runtime'
import system from '@/lib/api/extensions/default/routes/system'
import translate from '@/lib/api/extensions/default/routes/translate'
import upscale from '@/lib/api/extensions/default/routes/upscale'
import world from '@/lib/api/extensions/default/routes/world'

// Mount order determines the order of paths in the OpenAPI document.
export const routes: readonly HttpPlugin[] = [
  chatBatch,
  kvCache,
  system,
  runtime,
  modelFit,
  translate,
  ocr,
  classifications,
  registry,
  upscale,
  music,
  world
]
