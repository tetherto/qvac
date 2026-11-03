// Loads the engine and the llama.cpp addon in this thread and runs one
// completion. Reports JSON lines over `Bare.IPC`.

import { setConfig } from '@qvac/inference/engine'
import {
  registerPlugin,
  loadModel,
  completion,
  unloadModel,
  close,
  SMOLLM2_360M_INST_Q8
} from '@qvac/inference'
import { llmPlugin } from '@qvac/inference/llamacpp-completion/plugin'

function report(event, fields) {
  Bare.IPC.write(JSON.stringify({ event, ...fields }) + '\n')
}

async function main() {
  // A bundled thread cannot import a config file from disk, so inject it.
  setConfig({ cacheDirectory: Bare.argv[2] })
  registerPlugin(llmPlugin)

  const modelId = await loadModel({ modelSrc: SMOLLM2_360M_INST_Q8 })
  report('model-loaded', { modelId })

  const run = completion({
    modelId,
    history: [{ role: 'user', content: 'Reply with one short sentence about the sea.' }]
  })
  const text = await run.text
  report('completion', { text })

  await unloadModel({ modelId })

  if (text.trim() === '') throw new Error('Completion returned no text')
  report('result', { ok: true })
}

try {
  await main()
} catch (err) {
  report('result', { ok: false, error: err.stack })
} finally {
  // Open engine resources would keep the thread, and the app, alive.
  await close().catch(() => {})
  Bare.IPC.end()
}
