// Query the QVAC model registry (list / search / fetch metadata).
//
// A registry query uses no model, but engines must still be assembled
// before the first call — register the ones you care about, then query.
//
// Run: bare examples/registry-query.ts
// Requires: npm install @qvac/inference @qvac/llm-llamacpp @qvac/embed-llamacpp @qvac/transcription-whispercpp

import {
  plugins,
  modelRegistryList,
  modelRegistrySearch,
  modelRegistryGetModel,
  ModelType,
  close
} from '@qvac/inference'
import { llmPlugin } from '@qvac/inference/llamacpp-completion/plugin'
import { embeddingsPlugin } from '@qvac/inference/llamacpp-embedding/plugin'
import { whisperPlugin } from '@qvac/inference/whispercpp-transcription/plugin'

plugins([llmPlugin, embeddingsPlugin, whisperPlugin])

try {
  console.log('▸ QVAC Model Registry\n')

  const all = await modelRegistryList()
  console.log(`▸ ${all.length} models in registry\n`)

  console.log('▸ Sample models:')
  all.slice(0, 5).forEach((m) => {
    console.log(`   - ${m.name} (${m.engine}, ${formatSize(m.expectedSize)})`)
  })
  console.log()

  const whisper = await modelRegistrySearch({ filter: 'whisper' })
  console.log(`▸ Whisper matches: ${whisper.length}`)

  const embedders = await modelRegistrySearch({ engine: ModelType.llamacppEmbedding })
  console.log(`▸ Embedding models: ${embedders.length}\n`)

  const first = all[0]
  if (first) {
    const detail = await modelRegistryGetModel(first.registryPath, first.registrySource)
    console.log(
      `▸ ${detail.name}: ${formatSize(detail.expectedSize)}, ${detail.sha256Checksum.slice(0, 16)}...`
    )
  }

  await close()
} catch (error) {
  console.error('✖', error)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}
