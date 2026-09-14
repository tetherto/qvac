import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import kvCache from '@/serve/extensions/default/routes/kv-cache'
import translate from '@/serve/extensions/default/routes/translate'

// Mount order determines the order of paths in the OpenAPI document.
export const routes: readonly FastifyPluginAsyncZod[] = [kvCache, translate]
