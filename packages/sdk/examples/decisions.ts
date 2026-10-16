import { loadModel, decide, unloadModel, close, LAYA_MULTILINGUAL_322M_Q8_0 } from '@qvac/sdk'

const modelSrc = process.argv[2] ?? LAYA_MULTILINGUAL_322M_Q8_0

let modelId: string | undefined
try {
  console.error('▸ Loading decision model')
  modelId = await loadModel({
    modelSrc,
    modelType: 'llamacpp-decision',
    modelConfig: { device: 'cpu' }
  })
  const result = await decide({
    modelId,
    state: 'My payment failed twice and I was charged both times. Please refund the duplicate.',
    questions: {
      department: {
        type: 'choice',
        instructions: 'Which team should handle this ticket?',
        criteria: ['billing', 'technical']
      },
      urgency: {
        type: 'score',
        instructions: 'How urgent is this?',
        criteria: ['not urgent', 'somewhat urgent', 'very urgent']
      },
      refund: { type: 'noul', instructions: 'The customer asks for a refund.' }
    }
  })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error('✖', error)
  process.exitCode = 1
} finally {
  if (modelId) await unloadModel({ modelId })
  await close()
}
