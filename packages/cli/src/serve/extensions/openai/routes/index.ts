import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import audio from '@/serve/extensions/openai/routes/audio'
import chat from '@/serve/extensions/openai/routes/chat'
import completions from '@/serve/extensions/openai/routes/completions'
import embeddings from '@/serve/extensions/openai/routes/embeddings'
import files from '@/serve/extensions/openai/routes/files'
import images from '@/serve/extensions/openai/routes/images'
import modelsCatalog from '@/serve/extensions/openai/routes/models-catalog'
import models from '@/serve/extensions/openai/routes/models'
import responses from '@/serve/extensions/openai/routes/responses'
import vectorStores from '@/serve/extensions/openai/routes/vector-stores'
import videos from '@/serve/extensions/openai/routes/videos'

// Mount order determines the order of paths in the OpenAPI document.
export const routes: readonly FastifyPluginAsyncZod[] = [
  audio,
  chat,
  completions,
  embeddings,
  files,
  images,
  modelsCatalog,
  models,
  responses,
  vectorStores,
  videos
]
