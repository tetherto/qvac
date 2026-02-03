'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const LlmLlamacpp = require('../index')

const process = require('bare-process')

async function main () {
  const store = new Corestore('./store')

  // Create a Hyperdrive Dataloader instance
  const hdDL = new HyperDriveDL({
    key: 'hd://afa79ee07c0a138bb9f11bfaee771fb1bdfca8c82d961cff0474e49827bd1de3',
    store
  })

  // Create a LlmLlamacpp instance
  const args = {
    loader: hdDL,
    opts: { stats: true },
    logger: console,
    // saveWeightsToDisk: true, this is the default usage until we implement load method in addon.
    diskPath: './models/',
    modelName: 'Llama-3.2-1B-Instruct-Q4_0.gguf'
  }

  // an example of possible configuration
  const config = {
    gpu_layers: '99', // number of model layers offloaded to GPU.
    ctx_size: '10000', // context length
    device: 'gpu'
  }

  const model = new LlmLlamacpp(args, config)

  await model.load()

  try {
    // no cache will be saved
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
    const buffer1 = []

    await response1
      .onUpdate(data => {
        process.stdout.write(data)
        buffer1.push(data)
      })
      .await()

    const messages2 = [
      {
        role: 'user',
        content: 'what is Ethereum?'
      }
    ]

    const response2 = await model.run(messages2)
    const buffer2 = []

    await response2
      .onUpdate(data => {
        process.stdout.write(data)
        buffer2.push(data)
      })
      .await()

    // reset cache
    const messages3 = [
      {
        role: 'session',
        content: 'reset'
      },
      {
        role: 'user',
        content: 'who founded it?'
      }
    ]

    const response3 = await model.run(messages3)
    const buffer3 = []

    await response3
      .onUpdate(data => {
        process.stdout.write(data)
        buffer3.push(data)
      })
      .await()

    // switch to cache1.bin
    const messages4 = [
      {
        role: 'session',
        content: 'cache1.bin'
      },
      {
        role: 'user',
        content: 'what is bitcoin?'
      }
    ]

    const response4 = await model.run(messages4)
    const buffer4 = []

    await response4
      .onUpdate(data => {
        process.stdout.write(data)
        buffer4.push(data)
      })
      .await()

    const messages5 = [
      {
        role: 'user',
        content: 'can you elaborate on the previous topic?'
      }
    ]

    const response5 = await model.run(messages5)
    const buffer5 = []

    await response5
      .onUpdate(data => {
        process.stdout.write(data)
        buffer5.push(data)
      })
      .await()
  } finally {
    await store.close()
    await model.unload()
  }
}

main().catch(console.error)
