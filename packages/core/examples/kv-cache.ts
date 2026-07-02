// KV-cache reuse across turns. With `kvCache: true`, a completed turn's cache is
// saved and reused when the next turn shares the same history prefix, so only the
// new user message is processed.
//
// Run: bare examples/kv-cache.ts
// Requires: npm install @qvac/core @qvac/llm-llamacpp bare-stdio

import io from 'bare-stdio'
import {
  registerPlugin,
  loadModel,
  completion,
  unloadModel,
  LLAMA_3_2_1B_INST_Q4_0
} from '@qvac/core'
import { llmPlugin } from '@qvac/core/llamacpp-completion/plugin'

registerPlugin(llmPlugin)

try {
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelConfig: { ctx_size: 2048 }
  })

  console.log('▸ First turn (builds the cache):')
  const first = completion({
    modelId,
    history: [{ role: 'user', content: 'What is the capital of France?' }],
    stream: true,
    kvCache: true
  })
  for await (const token of first.tokenStream) {
    io.out.write(token)
  }
  const final1 = await first.final
  io.out.write('\n')

  console.log('▸ Second turn (reuses the previous turn cache):')
  const second = completion({
    modelId,
    history: [
      { role: 'user', content: 'What is the capital of France?' },
      { role: 'assistant', content: final1.cacheableAssistantContent ?? final1.contentText },
      { role: 'user', content: 'What about Germany?' }
    ],
    stream: true,
    kvCache: true
  })
  for await (const token of second.tokenStream) {
    io.out.write(token)
  }
  io.out.write('\n')

  await unloadModel({ modelId, autoClose: true })
} catch (error) {
  console.error('✖', error)
}
