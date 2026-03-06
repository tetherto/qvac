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
const maxTokens = args[3] || '50'

const modelName = path.basename(ggufPath)
const diskPath = path.dirname(ggufPath)

async function main () {
  const prompts = JSON.parse(fs.readFileSync(promptsFile, 'utf-8'))
  console.log(`Loaded ${prompts.length} prompts`)

  // Load FilesystemDL directly (same package used by modelManager)
  let FsDL
  try {
    FsDL = require('@qvac/dl-filesystem')
  } catch {
    // Fallback: resolve from main package node_modules
    FsDL = require('../../node_modules/@qvac/dl-filesystem')
  }

  const loader = new FsDL({ dirPath: diskPath })

  // Create LlmLlamacpp directly (bypassing modelManager) so we can pass
  // tools: 'true' which enables jinja template rendering for models with
  // custom chat templates (like AfriqueGemma)
  const model = new LlmLlamacpp({
    loader,
    logger: console,
    diskPath,
    modelName
  }, {
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
    verbosity: '1'
  })

  await model.load()
  console.log(`Model loaded: ${modelName}`)

  const outputs = []

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i]
    console.log(`Prompt ${i + 1}/${prompts.length}: ${prompt.substring(0, 60)}...`)

    const messages = [{ role: 'user', content: prompt }]
    const response = await model.run(messages)

    let text = ''
    let stopped = false
    await response
      .onUpdate(data => {
        if (stopped) return
        text += data
        if (text.includes('\n')) {
          text = text.split('\n')[0]
          stopped = true
          model.cancel()
        }
      })
      .await()

    outputs.push(text.trim())
    console.log(`  Output: ${text.trim()}`)
  }

  fs.writeFileSync(outputsFile, JSON.stringify(outputs, null, 2))
  console.log(`Outputs written to ${outputsFile}`)

  await model.unload()
  await loader.close()
}

main().catch(error => {
  console.error('Fatal error:', error.message || error)
  process.exit(1)
})
