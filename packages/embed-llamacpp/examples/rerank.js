'use strict'

const path = require('bare-path')
const process = require('bare-process')
const { Reranker } = require('../index')

// Usage: bare examples/rerank.js /path/to/reranker.gguf [gpu|cpu]
async function main () {
  console.log('Rerank Example: ranking documents by relevance to a query')
  console.log('==========================================================')

  const [modelPath, device = 'gpu'] = process.argv.slice(2)
  if (!modelPath) {
    console.error('Usage: bare examples/rerank.js <reranker.gguf> [gpu|cpu]')
    process.exitCode = 1
    return
  }

  // 1. Configuring the model. `device` is required; the reranker fixes the
  //    rest of the context itself.
  const reranker = new Reranker({
    files: { model: [path.resolve(modelPath)] },
    config: device === 'gpu' ? { device, gpu_layers: '99' } : { device },
    logger: console,
    opts: { stats: true }
  })

  // 2. Loading the model
  await reranker.load()

  try {
    // 3. Scoring every document against the query
    const query = 'How do I get a refund for a duplicate charge?'
    const documents = [
      'Refunds for duplicate or failed payments are issued within 5 business days.',
      'Our office is open Monday to Friday, 9am to 5pm.',
      'To change your password, open Settings and choose Security.',
      'If you were charged twice, contact billing with both transaction IDs.'
    ]
    const response = await reranker.run({ query, documents })
    const [scores] = await response.await()

    // 4. Sorting by score, most relevant first
    console.log(`\nQuery: ${query}\n`)
    scores
      .map((score, index) => ({ score, document: documents[index] }))
      .sort((a, b) => b.score - a.score)
      .forEach(({ score, document }) => console.log(`${score.toFixed(3)}  ${document}`))
    console.log('\nStats:', response.stats)
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
    // 5. Cleaning up resources
    await reranker.unload()
  }
}

main().catch(console.error)
