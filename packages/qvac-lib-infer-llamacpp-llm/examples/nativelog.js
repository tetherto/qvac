'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const LlmLlamacpp = require('../index')
const { setLogger, releaseLogger } = require('../addonLogging')

const process = require('bare-process')

async function main () {
  console.log('Native Logging Example: Demonstrates C++ addon logging integration')
  console.log('==================================================================')

  // 1. Setting up C++ logger - must be done before creating any addon instances
  console.log('Setting up C++ logger...')

  setLogger((priority, message) => {
    const priorityNames = {
      0: 'ERROR',
      1: 'WARNING',
      2: 'INFO',
      3: 'DEBUG'
    }

    const priorityName = priorityNames[priority] || 'UNKNOWN'
    const timestamp = new Date().toISOString()

    console.log(`[${timestamp}] [C++ TEST] [${priorityName}]: ${message}`)
  })

  console.log('Logger setup complete. C++ logging is now active.')
  console.log('Now creating addon instances...\n')

  // 2. Initializing data loader
  const store = new Corestore('./store')
  const hdStore = store.namespace('hd')

  const hdKey = 'afa79ee07c0a138bb9f11bfaee771fb1bdfca8c82d961cff0474e49827bd1de3'
  const hdDL = new HyperDriveDL({
    key: `hd://${hdKey}`,
    store: hdStore
  })

  // 3. Configuring model settings
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
    ctx_size: '1024',
    verbosity: '2'
  }

  // 4. Loading model
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
    // 5. Running inference with conversation prompt
    const prompt = [
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
        content: 'Can you elaborate on the previous topic?'
      }
    ]

    const response = await model.run(prompt)
    let fullResponse = ''

    await response
      .onUpdate(data => {
        process.stdout.write(data)
        fullResponse += data
      })
      .await()

    console.log('\n')
    console.log('Full response:\n', fullResponse)
    console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
    // 6. Cleaning up resources
    await store.close()
    await hdDL.close()
    await model.unload()
    releaseLogger()
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
