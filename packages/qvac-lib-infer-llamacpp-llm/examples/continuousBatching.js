'use strict'

const LlmLlamacpp = require('../index')
const path = require('bare-path')
const process = require('bare-process')
const { downloadModel } = require('./utils')

const MODEL = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}

const STORY_PROMPTS = [
  { id: 'forest-lantern', topic: 'a lantern found in a quiet forest' },
  { id: 'ocean-map', topic: 'an old map discovered near the ocean' },
  { id: 'mountain-clock', topic: 'a clock tower hidden in the mountains' },
  { id: 'desert-fox', topic: 'a fox crossing a moonlit desert' },
  { id: 'city-rain', topic: 'two friends meeting during city rain' },
  { id: 'garden-key', topic: 'a small key buried in a garden' },
  { id: 'river-boat', topic: 'a wooden boat drifting down a river' },
  { id: 'winter-star', topic: 'a bright star over a winter village' }
]

function buildPrompt (topic) {
  return [
    {
      role: 'system',
      content: 'Write a concise story in 80 to 120 words. Keep it vivid and simple.'
    },
    {
      role: 'user',
      content: `Tell me a story about ${topic}.`
    }
  ]
}

async function main () {
  console.log('Continuous Batching Example: 8 story prompts with parallel=4')
  console.log('=============================================================')

  const [modelName, dirPath] = await downloadModel(MODEL.url, MODEL.name)
  const modelPath = path.join(dirPath, modelName)

  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: {
      device: 'gpu',
      gpu_layers: '999',
      ctx_size: '4096',
      parallel: '4',
      n_predict: '128',
      temp: '0.7',
      top_p: '0.9'
    },
    logger: console,
    opts: { stats: true }
  })

  await model.load()

  try {
    const batchPrompts = STORY_PROMPTS.map(story => ({
      id: story.id,
      prompt: buildPrompt(story.topic),
      runOptions: { generationParams: { predict: 128 } }
    }))

    const response = await model.run(batchPrompts)
    const streamedTextById = new Map()
    const pendingChunksById = new Map()
    const chunkCountsById = new Map()
    const chunksPerLog = 12

    response.onUpdate(({ id, chunk }) => {
      const previous = streamedTextById.get(id) || ''
      streamedTextById.set(id, previous + chunk)

      const count = (chunkCountsById.get(id) || 0) + 1
      const pendingText = (pendingChunksById.get(id) || '') + chunk
      chunkCountsById.set(id, count)
      pendingChunksById.set(id, pendingText)
      if (count % chunksPerLog === 0) {
        console.log(`[chunk:${id}] ${pendingText.replace(/\s+/g, ' ').trim()}`)
        pendingChunksById.set(id, '')
      }
    })

    const results = await response.await()

    for (const [id, pendingText] of pendingChunksById) {
      const text = pendingText.replace(/\s+/g, ' ').trim()
      if (text.length > 0) {
        console.log(`[chunk:${id}] ${text}`)
      }
    }

    console.log('\nStats:')
    console.log(JSON.stringify(response.stats, null, 2))

    console.log('\nFull responses:')
    for (const result of results) {
      console.log(`\n${result.id}:`)
      console.log(result.output.trim())
    }
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
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
