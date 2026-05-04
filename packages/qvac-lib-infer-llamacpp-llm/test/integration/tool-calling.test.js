'use strict'

const test = require('brittle')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isMobile = platform === 'ios' || platform === 'android'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isLinuxArm64

const ALL_TOOL_MODEL_VARIANTS = [
  {
    id: 'qwen3-1.7b',
    modelName: 'Qwen3-1.7B-Q4_0.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_0.gguf'
  },
  {
    id: 'medgemma-4b-it',
    modelName: 'medgemma-4b-it-Q4_1.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/medgemma-4b-it-GGUF/resolve/main/medgemma-4b-it-Q4_1.gguf'
  }
]

// On mobile, only run qwen3-1.7b
const TOOL_MODEL_VARIANTS = isMobile
  ? ALL_TOOL_MODEL_VARIANTS.filter(m => m.id === 'qwen3-1.7b')
  : ALL_TOOL_MODEL_VARIANTS

const BASE_CONFIG = {
  device: useCpu ? 'cpu' : 'gpu',
  gpu_layers: '999',
  ctx_size: '8192',
  temp: '0.1',
  n_predict: '1024',
  verbosity: '2',
  tools: 'true'
}

const prompt1Base = [
  { role: 'system', content: 'You are a helpful assistant.' },
  {
    type: 'function',
    name: 'searchProducts',
    description: 'Search products',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query' },
        category: { type: 'string', enum: ['electronics', 'clothing', 'books'], description: 'Category' },
        maxPrice: { type: 'number', minimum: 0, description: 'Max price' }
      },
      required: ['query']
    }
  },
  {
    type: 'function',
    name: 'addToCart',
    description: 'Add items to cart',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productId: { type: 'string', description: 'Product ID' },
              quantity: { type: 'integer', minimum: 1, description: 'Quantity' }
            },
            required: ['productId', 'quantity']
          }
        }
      },
      required: ['items']
    }
  },
  {
    type: 'function',
    name: 'queryDB',
    description: 'Query database',
    parameters: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table' },
        conditions: {
          type: 'object',
          properties: {
            field: { type: 'string', description: 'Field' },
            operator: { type: 'string', enum: ['equals', 'greaterThan'], description: 'Operator' },
            value: { type: 'string', description: 'Value' }
          },
          required: ['field', 'operator', 'value']
        },
        limit: { type: 'integer', minimum: 1, default: 10, description: 'Limit' },
        includeMetadata: { type: 'boolean', default: false, description: 'Include metadata' }
      },
      required: ['table', 'conditions']
    }
  },
  {
    role: 'user',
    content: 'Search laptops under $1000 and add 2 with ID "laptop-123" to cart. Also, query users table age > 25 limit 50 with metadata.'
  }
]

function clonePrompt () {
  return JSON.parse(JSON.stringify(prompt1Base))
}

function buildPrompt2 (assistantOutput) {
  const prompt = clonePrompt()
  prompt.push({ role: 'assistant', content: assistantOutput })
  prompt.push({ role: 'user', content: 'Search tv above $2000' })
  return prompt
}

async function collectResponse (response) {
  const chunks = []
  await response
    .onUpdate(data => {
      chunks.push(data)
    })
    .await()

  const stats = response.stats || {}
  return {
    text: chunks.join('').trim(),
    generatedTokens: Number(stats.generatedTokens || 0)
  }
}

async function createToolModel (modelVariant) {
  const [modelName, dirPath] = await ensureModel({
    modelName: modelVariant.modelName,
    downloadUrl: modelVariant.downloadUrl
  })

  const modelPath = path.join(dirPath, modelName)
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  let loggerReleased = false
  const releaseLogger = () => {
    if (loggerReleased) return
    loggerReleased = true
    specLogger.release()
  }

  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: BASE_CONFIG,
    logger: console,
    opts: { stats: true }
  })

  try {
    await model.load()
  } catch (err) {
    releaseLogger()
    throw err
  }

  return {
    model,
    async release () {
      await model.unload().catch(() => {})
      releaseLogger()
    }
  }
}

async function runPrompt (model, prompt) {
  const response = await model.run(prompt)
  return await collectResponse(response)
}

test('[tools] prompt scenarios', { timeout: 1_800_000, skip: isDarwinX64 }, async t => {
  for (const modelVariant of TOOL_MODEL_VARIANTS) {
    const { model, release } = await createToolModel(modelVariant)
    const label = `[${modelVariant.id}]`

    try {
      const firstRun = await runPrompt(model, clonePrompt())
      t.ok(firstRun.text.length > 0, `${label} prompt1: generated text`)
      t.ok(firstRun.generatedTokens > 0, `${label} prompt1: generated tokens tracked`)

      const secondRun = await runPrompt(model, buildPrompt2(firstRun.text))
      t.ok(secondRun.text.length > 0, `${label} prompt2: generated text`)
      t.ok(secondRun.generatedTokens > 0, `${label} prompt2: generated tokens tracked`)
    } finally {
      await release()
    }
  }
})
