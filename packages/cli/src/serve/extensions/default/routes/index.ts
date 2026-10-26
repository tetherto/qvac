import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import chatBatch from '@/serve/extensions/default/routes/chat-batch'
import kvCache from '@/serve/extensions/default/routes/kv-cache'
import modelFit from '@/serve/extensions/default/routes/model-fit'
import ocr from '@/serve/extensions/default/routes/ocr'
import system from '@/serve/extensions/default/routes/system'
import translate from '@/serve/extensions/default/routes/translate'

// Mount order determines the order of paths in the OpenAPI document.
export const routes: readonly FastifyPluginAsyncZod[] = [
  chatBatch,
  kvCache,
  system,
  modelFit,
  translate,
  ocr
]
