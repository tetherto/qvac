import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import chatBatch from '@/serve/extensions/default/routes/chat-batch'
import classifications from '@/serve/extensions/default/routes/classifications'
import kvCache from '@/serve/extensions/default/routes/kv-cache'
import modelFit from '@/serve/extensions/default/routes/model-fit'
import music from '@/serve/extensions/default/routes/music'
import ocr from '@/serve/extensions/default/routes/ocr'
import registry from '@/serve/extensions/default/routes/registry'
import system from '@/serve/extensions/default/routes/system'
import translate from '@/serve/extensions/default/routes/translate'
import upscale from '@/serve/extensions/default/routes/upscale'

// Mount order determines the order of paths in the OpenAPI document.
export const routes: readonly FastifyPluginAsyncZod[] = [
  chatBatch,
  kvCache,
  system,
  modelFit,
  translate,
  ocr,
  classifications,
  registry,
  upscale,
  music
]
