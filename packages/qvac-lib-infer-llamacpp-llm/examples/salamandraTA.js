'use strict'

const LlmLlamacpp = require('../index')
const path = require('bare-path')
const process = require('bare-process')
const { downloadModel } = require('./utils')

async function main () {
  console.log('SalamandraTA Example: Demonstrates translation model capabilities')
  console.log('=================================================================')

  // 1. Downloading model
  const [modelName, dirPath] = await downloadModel(
    'https://huggingface.co/BSC-LT/salamandraTA-2B-instruct-GGUF/resolve/main/salamandrata_2b_inst_q4.gguf',
    'salamandrata_2b_inst_q4.gguf'
  )

  // 2. Configuring model settings
  const modelPath = path.join(dirPath, modelName)

  const config = {
    device: 'gpu',
    gpu_layers: '99',
    ctx_size: '1024'
  }

  // 3. Loading model
  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: console,
    opts: { stats: true }
  })
  await model.load()

  try {
    // 4. Running translation inference
    const messages = [
      {
        role: 'system',
        content: 'Translate the following text from Italian into Spanish. \n Italian: Ciao Tether è il migliore \n Spanish:'
      }
    ]

    const response = await model.run(messages)
    let fullResponse = ''

    await response
      .onUpdate(data => {
        process.stdout.write(data)
        fullResponse += data
      })
      .await()

    console.log('\n')
    console.log('Full translation:\n', fullResponse)
    console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
    // 5. Cleaning up resources
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
