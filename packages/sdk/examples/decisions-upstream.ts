// Upstream llama.cpp decision models (laya, openjev, lev, kev, clef, ...)
// through decide(), on @qvac/decision-ggml. Pass a GGUF path; Laya runs from
// its upstream-format conversion (convert_hf_to_gguf.py).
//
//   npx tsx examples/decisions-upstream.ts /path/to/model.gguf
import { loadModel, decide, getLoadedModelInfo, unloadModel, close } from '@qvac/sdk'

const modelSrc = process.argv[2]
if (!modelSrc) {
  console.error('✖ Usage: decisions-upstream.ts <decision-model.gguf>')
  process.exit(1)
}

let modelId: string | undefined
try {
  console.error('▸ Loading decision model')
  modelId = await loadModel({
    modelSrc,
    modelType: 'llamacpp-decision',
    modelConfig: { device: 'gpu' }
  })
  // What the model supports: its decision type, what noul means, the score
  // range and the longest input.
  const { decision } = await getLoadedModelInfo({ modelId })
  console.error('▸ Decision model', decision)

  const result = await decide({
    modelId,
    states: [
      'My payment failed twice and I was charged both times. Please refund the duplicate.',
      'The app crashes every time I open the settings page.'
    ],
    questions: {
      // The answer is one of these values, with its type (strings, numbers or booleans).
      route: {
        type: 'choice',
        instructions: 'Which queue should handle this ticket?',
        criteria: ['billing', 'technical', 'shipping']
      },
      urgency: {
        type: 'score',
        instructions: 'How urgent is this?',
        criteria: ['not urgent', 'somewhat urgent', 'very urgent']
      },
      // The probability that the statement holds. A model whose noul is an
      // expected rating (lev) rejects it unless the question sets allowRating.
      refund: { type: 'noul', instructions: 'Does the customer ask for a refund?' }
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
