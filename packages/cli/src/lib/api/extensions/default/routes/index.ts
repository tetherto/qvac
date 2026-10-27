import type { HttpPlugin } from '@/lib/http'
import chatBatch from '@/lib/api/extensions/default/routes/chat-batch'
import classifications from '@/lib/api/extensions/default/routes/classifications'
import kvCache from '@/lib/api/extensions/default/routes/kv-cache'
import modelFit from '@/lib/api/extensions/default/routes/model-fit'
import ocr from '@/lib/api/extensions/default/routes/ocr'
import system from '@/lib/api/extensions/default/routes/system'
import translate from '@/lib/api/extensions/default/routes/translate'

// Mount order determines the order of paths in the OpenAPI document.
export const routes: readonly HttpPlugin[] = [
  chatBatch,
  kvCache,
  system,
  modelFit,
  translate,
  ocr,
  classifications
]
