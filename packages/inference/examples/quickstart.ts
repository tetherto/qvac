// The canonical getting-started: load an LLM and stream a completion, in-process
// on Bare. No logs are printed by default; point QVAC_CONFIG_PATH at a config
// that sets "loggerConsoleOutput": true to see client and server logs.
//
// Run: bare examples/quickstart.ts
// Requires: npm install @qvac/inference @qvac/llm-llamacpp bare-stdio

import io from 'bare-stdio'
import {
  registerPlugin,
  loadModel,
  completion,
  unloadModel,
  LLAMA_3_2_1B_INST_Q4_0
} from '@qvac/inference'
import { llmPlugin } from '@qvac/inference/llamacpp-completion/plugin'

// No plugins are registered by default. Register the engine you need, then use the
// same API as @qvac/sdk.
registerPlugin(llmPlugin)

try {
  // Load a model into memory (downloaded and cached on first run).
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      io.err.write(
        `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)\n`
      )
    }
  })

  // You can use the loaded model multiple times.
  const history = [{ role: 'user', content: 'Explain quantum computing in one sentence' }]
  const result = completion({ modelId, history, stream: true })
  for await (const token of result.tokenStream) {
    io.out.write(token)
  }
  io.out.write('\n')

  // Unload the model to free system resources.
  await unloadModel({ modelId, autoClose: true })
} catch (error) {
  console.error('✖', error)
}
