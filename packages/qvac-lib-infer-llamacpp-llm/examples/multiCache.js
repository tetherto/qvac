'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const LlmLlamacpp = require('../index')
const process = require('bare-process')

async function main () {
  console.log('Multi-Cache Example: Demonstrates cache management with multiple cache files')
  console.log('============================================================================')

  // 1. Initializing data loader
  const store = new Corestore('./store')
  const hdStore = store.namespace('hd')

  const hdKey = 'afa79ee07c0a138bb9f11bfaee771fb1bdfca8c82d961cff0474e49827bd1de3'
  const hdDL = new HyperDriveDL({
    key: `hd://${hdKey}`,
    store: hdStore
  })

  // 2. Configuring model settings
  const args = {
    loader: hdDL,
    opts: { stats: true },
    logger: console,
    modelName: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
    diskPath: './models'
  }

  const config = {
    device: 'gpu',
    gpu_layers: '99',
    ctx_size: '10000'
  }

  // 3. Loading model
  await hdDL.ready()
  const model = new LlmLlamacpp(args, config)
  const closeLoader = true
  let totalProgress = 0
  const reportProgressCallback = (report) => {
    if (typeof report === 'object' && Number(report.overallProgress) > totalProgress) {
      process.stdout.write(
        `\r${report.overallProgress}%: ${report.action} [${report.filesProcessed}/${report.totalFiles}] ${report.currentFileProgress}% ${report.currentFile}`
      )
      if (Number(report.currentFileProgress) === 100) {
        process.stdout.write('\n')
      }
      totalProgress = Number(report.overallProgress)
    }
  }
  await model.load(closeLoader, reportProgressCallback)

  try {
    // 4. First conversation - no cache will be used. One shot inference
    const messages = [
      {
        role: 'system',
        content: 'You are a helpful, respectful and honest assistant.'
      },
      {
        role: 'user',
        content: 'what is bitcoin?'
      },
      {
        role: 'assistant',
        content: "It's a digital currency."
      },
      {
        role: 'user',
        content: 'Can you elaborate on the previous topic? No more than 10 lines.'
      }
    ]

    const response1 = await model.run(messages)
    let fullResponse1 = ''

    await response1
      .onUpdate(data => {
        process.stdout.write(data)
        fullResponse1 += data
      })
      .await()

    console.log('\n')
    console.log('Full response:\n', fullResponse1)
    console.log(`Inference stats: ${JSON.stringify(response1.stats)}`)
    console.log('\n')

    // 5. Switching to a new session with cache1.bin file
    const messages2 = [
      {
        role: 'session',
        content: 'cache1.bin'
      },
      {
        role: 'user',
        content: 'what is bitcoin?'
      }
    ]

    const response2 = await model.run(messages2)
    let fullResponse2 = ''

    await response2
      .onUpdate(data => {
        process.stdout.write(data)
        fullResponse2 += data
      })
      .await()

    console.log('\n')
    console.log('Full response:\n', fullResponse2)
    console.log(`Inference stats: ${JSON.stringify(response2.stats)}`)
    console.log('\n')

    // 6. Continuing conversation with cache1.bin
    const messages3 = [
      {
        role: 'session',
        content: 'cache1.bin'
      },
      {
        role: 'user',
        content: 'can you elaborate on the previous topic?'
      }
    ]

    const response3 = await model.run(messages3)
    let fullResponse3 = ''

    await response3
      .onUpdate(data => {
        process.stdout.write(data)
        fullResponse3 += data
      })
      .await()

    console.log('\n')
    console.log('Full response:\n', fullResponse3)
    console.log(`Inference stats: ${JSON.stringify(response3.stats)}`)
    console.log('\n')
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
    // 7. Cleaning up resources
    await store.close()
    await hdDL.close()
    await model.unload()
  }
}

main().catch(error => {
  console.error('Fatal error in main function:', {
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  })
  process.exit(1)
})
