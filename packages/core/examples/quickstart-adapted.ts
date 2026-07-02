// The SDK's quickstart, adapted for Bare with @qvac/core. Three edits: import
// from `@qvac/core` instead of `@qvac/sdk`, import `process` from bare-process
// (Bare has no `process` global), and register the plugins this example uses
// via `plugins([...])`.

import process from 'bare-process'
import { plugins, LLAMA_3_2_1B_INST_Q4_0 } from '@qvac/core'
import { llmPlugin } from '@qvac/core/llamacpp-completion/plugin'

const { loadModel, completion, unloadModel } = plugins([llmPlugin])

// From here it is the same as the SDK's quickstart.
const modelId = await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0 })

const history = [{ role: 'user', content: 'Explain quantum computing in one sentence' }]
const result = completion({ modelId, history, stream: true })
for await (const token of result.tokenStream) {
  process.stdout.write(token)
}

await unloadModel({ modelId, autoClose: true })
