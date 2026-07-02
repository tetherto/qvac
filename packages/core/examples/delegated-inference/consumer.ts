// Remote inference — consumer side. Runs a model on a remote provider instead
// of locally by passing `delegate: { providerPublicKey }` to loadModel.
//
// Run: bare examples/delegated-inference/consumer.ts <provider-public-key>
// Requires: npm install @qvac/core @qvac/llm-llamacpp bare-stdio

import io from 'bare-stdio'
import { registerPlugin, loadModel, completion, close, LLAMA_3_2_1B_INST_Q4_0 } from '@qvac/core'
import { llmPlugin } from '@qvac/core/llamacpp-completion/plugin'

// Registered so `fallbackToLocal` can run the model locally if delegation fails.
registerPlugin(llmPlugin)

const providerPublicKey = Bare.argv.slice(2)[0]
if (!providerPublicKey) {
  console.error('Usage: bare examples/delegated-inference/consumer.ts <provider-public-key>')
} else {
  try {
    const modelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      // 60s timeout: the first lookup on a cold DHT can take a while; later
      // calls in the same process are sub-second once the DHT is warm.
      delegate: { providerPublicKey, timeout: 60_000, fallbackToLocal: true }
    })
    console.log(`▸ Delegated model registered: ${modelId}`)

    const run = completion({
      modelId,
      history: [{ role: 'user', content: 'Hello!' }],
      stream: true
    })
    for await (const token of run.tokenStream) {
      io.out.write(token)
    }
    io.out.write('\n')

    await close()
  } catch (error) {
    console.error('✖', error)
  }
}
