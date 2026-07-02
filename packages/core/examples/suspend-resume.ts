// Suspend and resume the engine (e.g. app backgrounding). While suspended, most
// operations are blocked; `state()` reports the lifecycle state.
//
// Run: bare examples/suspend-resume.ts
// Requires: npm install @qvac/core @qvac/llm-llamacpp bare-stdio

import io from 'bare-stdio'
import {
  registerPlugin,
  loadModel,
  completion,
  unloadModel,
  suspend,
  resume,
  state,
  LLAMA_3_2_1B_INST_Q4_0
} from '@qvac/core'
import { llmPlugin } from '@qvac/core/llamacpp-completion/plugin'

registerPlugin(llmPlugin)

try {
  const modelId = await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0 })
  console.log(`▸ Model loaded. Lifecycle state: ${await state()}`)

  const before = completion({
    modelId,
    history: [{ role: 'user', content: 'Say hello in one word' }],
    stream: true
  })
  for await (const token of before.tokenStream) {
    io.out.write(token)
  }
  io.out.write('\n')

  console.log('▸ Suspending...')
  await suspend()
  console.log(`▸ Lifecycle state: ${await state()}`)

  try {
    await completion({
      modelId,
      history: [{ role: 'user', content: 'This should fail' }],
      stream: false
    }).text
  } catch (error) {
    const name = (error as { name?: string }).name
    if (name === 'LIFECYCLE_OPERATION_BLOCKED') {
      console.log(`▸ Operation blocked while suspended (${name})`)
    } else {
      throw error
    }
  }

  console.log('▸ Resuming...')
  await resume()
  console.log(`▸ Lifecycle state: ${await state()}`)

  const after = completion({
    modelId,
    history: [{ role: 'user', content: 'Say goodbye in one word' }],
    stream: true
  })
  for await (const token of after.tokenStream) {
    io.out.write(token)
  }
  io.out.write('\n')

  await unloadModel({ modelId, autoClose: true })
} catch (error) {
  console.error('✖', error)
}
