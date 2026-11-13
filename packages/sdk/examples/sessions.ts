/**
 * Two caller sessions on one runtime.
 *
 * Each session gets its own requests and model leases:
 *
 *  - Both sessions load the same configuration and get the same `modelId`;
 *    the second load adds a lease instead of loading the model again.
 *  - A session's `cancel({ requestId })` reaches only its own requests, so
 *    the second session's cancel leaves the first session's completion
 *    running; the first session's own cancel stops it.
 *  - `unloadModel()` releases the caller's lease. The model unloads when its
 *    last lease is released, here when the second session closes.
 *
 * Only the module-level `close()` stops the runtime; it ends every session.
 */

import { close, getLoadedModelInfo, openSession, QWEN3_600M_INST_Q4 } from '@qvac/sdk'

try {
  const harness = openSession({ name: 'harness' })
  const skillRunner = openSession({ name: 'skill-runner' })

  const modelId = await harness.loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelConfig: { ctx_size: 4096 }
  })
  const sameModelId = await skillRunner.loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelConfig: { ctx_size: 4096 }
  })
  const { leaseCount } = await getLoadedModelInfo({ modelId })
  console.log(`▸ same model for both sessions: ${modelId === sameModelId}, leases: ${leaseCount}`)

  const run = harness.completion({
    modelId,
    history: [{ role: 'user', content: 'Write a long essay about the history of Rome.' }],
    stream: true
  })

  // The skill runner cannot reach the harness's request.
  await skillRunner.cancel({ requestId: run.requestId })

  let deltasAfterForeignCancel = 0
  let stopReason: string | undefined
  for await (const event of run.events) {
    if (event.type === 'contentDelta') {
      deltasAfterForeignCancel++
      // The harness stops its own completion after a few more tokens.
      if (deltasAfterForeignCancel === 5) await harness.cancel({ requestId: run.requestId })
    } else if (event.type === 'completionDone') {
      stopReason = event.stopReason
    }
  }
  console.log(
    `▸ ${deltasAfterForeignCancel} tokens arrived after skill-runner's cancel; harness's cancel ended the run: stopReason=${stopReason}`
  )

  const result = await harness.unloadModel({ modelId })
  console.log(`▸ harness unload: released=${result.released}, unloaded=${result.unloaded}`)

  // Closing a session releases its leases; this was the model's last one.
  await skillRunner.close()
  console.log('▸ skill-runner closed and released the last lease')

  await harness.close()
  await close()
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
