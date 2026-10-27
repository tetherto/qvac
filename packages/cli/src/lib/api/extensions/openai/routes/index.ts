import type { HttpPlugin } from '@/lib/http'
import audio from '@/lib/api/extensions/openai/routes/audio'
import chat from '@/lib/api/extensions/openai/routes/chat'
import completions from '@/lib/api/extensions/openai/routes/completions'
import decisions from '@/lib/api/extensions/openai/routes/decisions'
import embeddings from '@/lib/api/extensions/openai/routes/embeddings'
import files from '@/lib/api/extensions/openai/routes/files'
import images from '@/lib/api/extensions/openai/routes/images'
import modelsCatalog from '@/lib/api/extensions/openai/routes/models-catalog'
import models from '@/lib/api/extensions/openai/routes/models'
import responses from '@/lib/api/extensions/openai/routes/responses'
import vectorStores from '@/lib/api/extensions/openai/routes/vector-stores'
import videos from '@/lib/api/extensions/openai/routes/videos'

// Mount order determines the order of paths in the OpenAPI document.
export const routes: readonly HttpPlugin[] = [
  audio,
  chat,
  completions,
  decisions,
  embeddings,
  files,
  images,
  modelsCatalog,
  models,
  responses,
  vectorStores,
  videos
]
