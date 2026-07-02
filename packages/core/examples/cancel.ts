// Cancel a specific in-flight completion by `requestId`. The events stream ends
// normally with `stopReason: "cancelled"`; the promise-aggregates (`text`,
// `final`, ...) reject with `InferenceCancelledError` carrying partial state.
//
// Run: bare examples/cancel.ts
// Requires: npm install @qvac/core @qvac/llm-llamacpp bare-stdio

import io from 'bare-stdio'
import {
  registerPlugin,
  loadModel,
  completion,
  cancel,
  unloadModel,
  InferenceCancelledError,
  QWEN3_600M_INST_Q4
} from '@qvac/core'
import { llmPlugin } from '@qvac/core/llamacpp-completion/plugin'

registerPlugin(llmPlugin)

try {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4, modelConfig: { ctx_size: 4096 } })

  const run = completion({
    modelId,
    history: [{ role: 'user', content: 'Write a long, detailed essay about the Roman Empire.' }],
    stream: true
  })
  console.log(`▸ requestId: ${run.requestId}`)

  // Cancel mid-decode.
  setTimeout(() => {
    void cancel({ requestId: run.requestId })
    console.log('\n▸ cancel issued')
  }, 250)

  // Channel 1: the events stream ends normally on cancel.
  let endReason: string | undefined
  for await (const event of run.events) {
    if (event.type === 'contentDelta') io.out.write(event.text)
    else if (event.type === 'completionDone') endReason = event.stopReason
  }
  console.log(`\n▸ stream ended, stopReason=${endReason}`)

  // Channel 2: the aggregate rejects with InferenceCancelledError.
  try {
    await run.text
  } catch (err) {
    if (err instanceof InferenceCancelledError) {
      console.log(
        `▸ run.text rejected: cancelled, partial length ${(err.partial.text ?? '').length}`
      )
    } else {
      throw err
    }
  }

  await unloadModel({ modelId, autoClose: true })
} catch (error) {
  console.error('✖', error)
}
