// Upstream llama.cpp decision models (openjev, lev, kev, clef, upstream-format
// laya, ...) through decide(). Pass a GGUF path: the plugin picks the upstream
// engine from the file, or the Laya engine for a fabric-format Laya checkpoint.
//
//   npx tsx examples/decisions-upstream.ts /path/to/model.gguf
import { loadModel, decide, unloadModel, close } from '@qvac/sdk'

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
      // Rejected by a model whose noul is not a probability (lev).
      refund: {
        type: 'noul',
        instructions: 'Does the customer ask for a refund?',
        requireProbability: true
      }
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
