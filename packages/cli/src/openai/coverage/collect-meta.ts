import { META as filesMeta } from '../../serve/adapters/openai/routes/files.js'
import { META as imagesMeta } from '../../serve/adapters/openai/routes/images.js'
import { META as responsesMeta } from '../../serve/adapters/openai/routes/responses.js'
import { META as responsesIdMeta } from '../../serve/adapters/openai/routes/responses-id.js'
import { META as speechMeta } from '../../serve/adapters/openai/routes/speech.js'
import { META as vectorStoresMeta } from '../../serve/adapters/openai/routes/vector-stores.js'

type RouteMetaBlock = {
  endpoints: readonly string[]
  caveats: readonly string[]
}

const META_BLOCKS: RouteMetaBlock[] = [
  filesMeta,
  imagesMeta,
  responsesMeta,
  responsesIdMeta,
  speechMeta,
  vectorStoresMeta
]

export function collectMeta (): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const block of META_BLOCKS) {
    for (const endpoint of block.endpoints) {
      map.set(endpoint, [...block.caveats])
    }
  }
  return map
}
