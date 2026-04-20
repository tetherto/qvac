'use strict'

const LlmLlamacpp = require('@qvac/llm-llamacpp')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

const args = process.argv.slice(2)

if (args.length < 3) {
  console.error('Usage: bare bare_infer.js <gguf_path> <prompts.json> <outputs.json> [max_tokens]')
  process.exit(1)
}

const ggufPath = args[0]
const promptsFile = args[1]
const outputsFile = args[2]
const maxTokens = args[3] || '256'

const modelName = path.basename(ggufPath)
const diskPath = path.dirname(ggufPath)

async function main () {
  const prompts = JSON.parse(fs.readFileSync(promptsFile, 'utf-8'))
  console.log(`Loaded ${prompts.length} prompts`)

  // Create LlmLlamacpp directly (bypassing modelManager) so we can pass
  // tools: 'true' which enables jinja template rendering for models with
  // custom chat templates (like AfriqueGemma)
  const model = new LlmLlamacpp({
    files: { model: [path.join(diskPath, modelName)] },
    config: {
      device: 'cpu',
      gpu_layers: '0',
      ctx_size: '2048',
      temp: '0',
      top_p: '1',
      top_k: '1',
      predict: maxTokens,
      repeat_penalty: '1',
      seed: '42',
      tools: 'true',
      'reverse-prompt': '\n',
      verbosity: '1'
    },
    logger: console
  })

  await model.load()
  console.log(`Model loaded: ${modelName}`)

  const outputs = []

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i]
    console.log(`Prompt ${i + 1}/${prompts.length}: ${prompt.substring(0, 60)}...`)

    const messages = [{ role: 'user', content: prompt }]
    const response = await model.run(messages)

    const chunks = []
    await response
      .onUpdate(data => { chunks.push(data) })
      .await()

    const output = chunks.join('').split('\n')[0].trim()
    outputs.push(output)
    console.log(`  Output: ${output}`)
  }

  fs.writeFileSync(outputsFile, JSON.stringify(outputs, null, 2))
  console.log(`Outputs written to ${outputsFile}`)

  await model.unload()
}

main().catch(error => {
  console.error('Fatal error:', error.message || error)
  process.exit(1)
})
