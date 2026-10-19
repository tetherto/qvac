'use strict'

const path = require('bare-path')
const process = require('bare-process')
const { LayaDecisions } = require('../index')

// Usage: bare examples/layaDecisions.js /path/to/laya-multilingual-Q8_0.gguf [gpu|cpu]
async function main () {
  console.log('Laya Decisions Example: typed decisions about a support ticket, one forward pass per question')
  console.log('=============================================================================================')

  const [modelPath, device = 'gpu'] = process.argv.slice(2)
  if (!modelPath) {
    console.error('Usage: bare examples/layaDecisions.js <laya.gguf> [gpu|cpu]')
    process.exitCode = 1
    return
  }

  // 1. Configuring the model. `device` is required; Laya fixes the rest of
  //    the context itself.
  const laya = new LayaDecisions({
    files: { model: [path.resolve(modelPath)] },
    config: device === 'gpu' ? { device, gpu_layers: '99' } : { device },
    logger: console,
    opts: { stats: true }
  })

  // 2. Loading the model
  await laya.load()

  try {
    // 3. Asking one question of each type about one state
    const response = await laya.run({
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
    console.log(`refund:     P(true) = ${refund.noul}`)
    console.log('stats:', response.stats)

    // 4. Asking the same questions about several states in one call
    const batch = await laya.run({
      states: [
        'The app crashes every time I open the settings page.',
        'Can I get an invoice for last month?'
      ],
      questions: {
        department: {
          type: 'choice',
          instructions: 'Which team should handle this ticket?',
          criteria: ['billing', 'technical']
        }
      }
    })
    const [results] = await batch.await()
    results.forEach((r, i) => console.log(`state ${i}: ${r.answers.department.choice}`))
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
    // 5. Cleaning up resources
    await laya.unload()
  }
}

main().catch(console.error)
