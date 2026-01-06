'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const LlmLlamacpp = require('../index')
const fs = require('bare-fs')
const process = require('bare-process')

async function main () {
  const store = new Corestore('./store')

  // Create a Hyperdrive Dataloader instance
  const hdStore = store.namespace('hd')
  const hdDL = new HyperDriveDL({
    key: 'hd://e65db178dfa6d027a91b4d263c30f7596e742cd7ea5c7f1ba91584113c3a47f1',
    store: hdStore
  })

  // Create a LlmLlamacpp instance
  const args = {
    loader: hdDL,
    opts: { stats: true },
    logger: console,
    diskPath: './models/',
    modelName: 'Qwen2.5-Omni-3B-Q4_K_M.gguf',
    projectionModel: 'mmproj-Qwen2.5-Omni-3B-Q8_0.gguf'
  }

  // an example of possible configuration
  const config = {
    gpu_layers: '99', // number of model layers offloaded to GPU.
    ctx_size: '2048', // context length
    device: 'gpu'
  }

  const model = new LlmLlamacpp(args, config)

  await model.load(true, console.log)

  const audioBuffer = new Uint8Array(fs.readFileSync('media/test.mp3'))
  const imageFilePath = 'media/news-paper.jpg'

  try {
    const messages1 = [
      {
        role: 'session',
        content: 'cache0.bin'
      },
      {
        role: 'system',
        content: 'You are a helpful, respectful and honest assistant.'
      },
      {
        role: 'user',
        type: 'media',
        content: audioBuffer
      },
      {
        role: 'user',
        content: 'what is this file about?'
      }
    ]

    console.log('\n\n')
    const response = await model.run(messages1)
    const buffer = []
    await response
      .onUpdate(data => {
        process.stdout.write(data)
        buffer.push(data)
      })
      .await()

    const messages2 = [
      {
        role: 'user',
        content: 'what i asked you before? answer shortly'
      }
    ]

    console.log('\n\n')
    const response2 = await model.run(messages2)
    const buffer2 = []

    await response2
      .onUpdate(data => {
        process.stdout.write(data)
        buffer2.push(data)
      })
      .await()

    const messages3 = [
      {
        role: 'session',
        content: 'cache1.bin'
      },
      {
        role: 'system',
        content: 'You are a helpful, respectful and honest assistant.'
      },
      {
        role: 'user',
        type: 'media',
        content: imageFilePath
      },
      {
        role: 'user',
        content: 'what is this file about?'
      }
    ]

    console.log('\n\n')
    const response3 = await model.run(messages3)
    const buffer3 = []

    await response3
      .onUpdate(data => {
        process.stdout.write(data)
        buffer3.push(data)
      })
      .await()

    const messages4 = [
      {
        role: 'session',
        content: 'cache0.bin'
      },
      {
        role: 'user',
        content: 'what i asked you before? answer shortly'
      }
    ]

    console.log('\n\n')
    const response4 = await model.run(messages4)
    const buffer4 = []

    await response4
      .onUpdate(data => {
        process.stdout.write(data)
        buffer4.push(data)
      })
      .await()

    console.log('\n')
  } finally {
    await store.close()
    await model.unload()
  }
}

main().catch(console.error)
