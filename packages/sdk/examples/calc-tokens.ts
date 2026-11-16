import { QWEN3_600M_INST_Q4, calcTokens, close, loadModel, unloadModel } from '@qvac/sdk'

let modelId: string | undefined
try {
  modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 })

  const raw = await calcTokens({ modelId, text: 'Summarize this conversation.' })
  const rendered = await calcTokens({
    modelId,
    history: [{ role: 'system', content: 'You are a helpful assistant.' }],
    text: 'Summarize this conversation.'
  })

  console.log({ raw, rendered })
} catch (error) {
  console.error('✖', error)
  process.exitCode = 1
} finally {
  if (modelId) await unloadModel({ modelId })
  await close()
}
