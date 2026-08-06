// Stream the engine's own logs while running inference. The loggers are console-off
// by default; `loggingStream` forwards them regardless of level.
// Configure the level with "loggerLevel" in qvac.config.json.
//
// Run: bare examples/logging.ts
// Requires: npm install @qvac/inference @qvac/llm-llamacpp

import {
  registerPlugin,
  loadModel,
  completion,
  unloadModel,
  loggingStream,
  LOG_ID,
  LLAMA_3_2_1B_INST_Q4_0
} from '@qvac/inference'
import { llmPlugin } from '@qvac/inference/llamacpp-completion/plugin'

registerPlugin(llmPlugin)

// Consume server logs in the background until the engine closes.
void (async () => {
  for await (const log of loggingStream({ id: LOG_ID })) {
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
