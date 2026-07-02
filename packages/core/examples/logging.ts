// Stream the SDK's server-side logs while running inference. Core's own loggers
// are console-off by default; `loggingStream` forwards them regardless of level.
// Configure the level with "loggerLevel" in qvac.config.json.
//
// Run: bare examples/logging.ts
// Requires: npm install @qvac/core @qvac/llm-llamacpp

import {
  registerPlugin,
  loadModel,
  completion,
  unloadModel,
  loggingStream,
  SDK_LOG_ID,
  LLAMA_3_2_1B_INST_Q4_0
} from '@qvac/core'
import { llmPlugin } from '@qvac/core/llamacpp-completion/plugin'

registerPlugin(llmPlugin)

// Consume server logs in the background until the engine closes.
void (async () => {
  for await (const log of loggingStream({ id: SDK_LOG_ID })) {
    console.log(`[${log.level.toUpperCase()}] [${log.namespace}] ${log.message}`)
  }
})()

try {
  const modelId = await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0 })
  const run = completion({
    modelId,
    history: [{ role: 'user', content: 'Say hi in one word' }],
    stream: false
  })
  console.log('▸ Answer:', await run.text)

  await unloadModel({ modelId, autoClose: true })
} catch (error) {
  console.error('✖', error)
}
