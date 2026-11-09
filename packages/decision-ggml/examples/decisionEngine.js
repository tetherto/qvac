'use strict'

const path = require('bare-path')
const process = require('bare-process')
const { DecisionEngine, DECISION_INVALID_REQUEST } = require('../index')

// Usage: bare examples/decisionEngine.js /path/to/laya-Q8_0.gguf [gpu|cpu]
// Any upstream decision model works: laya (converted from its Hugging Face
// checkpoint, see the README), openjev, lev, kev, clef, ...
async function main () {
  console.log('Decision Engine Example: typed decisions about a support ticket')
  console.log('==============================================================')

  const [modelPath, device = 'gpu'] = process.argv.slice(2)
  if (!modelPath) {
    console.error('Usage: bare examples/decisionEngine.js <decision-model.gguf> [gpu|cpu]')
    process.exitCode = 1
    return
  }

  // 1. Configuring the model. `device` is required; upstream fits the rest.
  const engine = new DecisionEngine({
    files: { model: [path.resolve(modelPath)] },
    config: device === 'gpu' ? { device, gpu_layers: '99' } : { device },
    logger: console
  })

  // 2. Loading the model, and checking what it supports
  await engine.load()

  try {
    const info = engine.info()
    console.log(`model: ${info.decision_type}, noul answers a ${info.noul}`)

    // 3. Asking one question of each type about one state
    const response = await engine.run({
      state: 'My payment failed twice and I was charged both times. Please refund the duplicate.',
      questions: {
        department: {
          type: 'choice',
          instructions: 'Which team should handle this ticket?',
          criteria: { billing: 'payments, refunds, invoices', technical: 'bugs, outages, errors' }
        },
        urgency: {
          type: 'score',
          instructions: 'How urgent is this?',
          criteria: ['not urgent', 'somewhat urgent', 'very urgent']
        },
        refund: { type: 'noul', instructions: 'The customer asks for a refund.' }
      }
    })
    const [result] = await response.await()

    const { department, urgency, refund } = result.answers
    console.log(`department: ${department.choice} (p = ${department.probabilities[department.choice]})`)
    console.log(`urgency:    ${urgency.score} on a 0-2 scale`)
    console.log(`refund:     ${refund.noul}`)
    console.log(`input tokens: ${result.usage.input_tokens}`)

    // 4. A request the model does not accept fails with DECISION_INVALID_REQUEST
    try {
      const rejected = await engine.run({
        state: 'x',
        questions: { q: { type: 'pick', instructions: 'Which?' } }
      })
      await rejected.await()
    } catch (error) {
      if (error.code !== DECISION_INVALID_REQUEST) throw error
      console.log(`rejected as expected: ${error.message}`)
    }
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
    // 5. Cleaning up resources
    await engine.unload()
  }
}

main().catch(console.error)
