'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const bareProcess = require('bare-process')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../index.js')
const { ensureModel } = require('./helpers')

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, 'perf-config.json')

const parseArgs = (argv) => {
  const args = {
    config: DEFAULT_CONFIG_PATH,
    input: null,
    output: null,
    addon: null
  }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--config') args.config = argv[++i]
    else if (arg === '--input') args.input = argv[++i]
    else if (arg === '--output') args.output = argv[++i]
    else if (arg === '--addon') args.addon = argv[++i]
  }
  return args
}

const readJsonl = (filePath) => {
  const content = fs.readFileSync(filePath, 'utf-8')
  return content
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

const writeJsonl = (filePath, rows) => {
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
}

const hashText = (text) => {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i)
  }
  return String(hash >>> 0)
}

const buildJudgePrompt = (question, response) => {
  return [
    { role: 'system', content: 'You are an impartial judge evaluating the quality of an AI assistant response.' },
    {
      role: 'user',
      content: [
        `Question: ${question}`,
        `AI Response: ${response}`,
        'Rate the response on a scale of 0.0 to 1.0:',
        '- 1.0: Completely correct and relevant answer',
        '- 0.7-0.9: Mostly correct with minor issues',
        '- 0.4-0.6: Partially correct',
        '- 0.1-0.3: Mostly incorrect',
        '- 0.0: Completely wrong or irrelevant',
        'Output ONLY a JSON object: {"score": <number>, "reason": "<brief explanation>"}'
      ].join('\n')
    }
  ]
}

const parseJudgeResponse = (text) => {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) {
    return { score: null, reason: text.trim() }
  }
  try {
    const parsed = JSON.parse(match[0])
    return { score: parsed.score ?? null, reason: parsed.reason ?? '' }
  } catch (error) {
    return { score: null, reason: text.trim() }
  }
}

const resolveAddonModule = (addonSpec) => {
  if (!addonSpec) {
    return LlmLlamacpp
  }
  try {
    return require(addonSpec)
  } catch (error) {
    return require(path.resolve(addonSpec))
  }
}

const run = async () => {
  const argv = bareProcess?.argv || (typeof process !== 'undefined' ? process.argv : [])
  const args = parseArgs(argv)
  if (!args.input) {
    throw new Error('Missing --input JSONL file')
  }

  const config = JSON.parse(fs.readFileSync(args.config, 'utf-8'))
  const judgeModel = config.judgeModel
  if (!judgeModel) {
    throw new Error('Missing judgeModel in perf-config.json')
  }
  const judgeConfig = (config.models || []).find(model => model.id === judgeModel.modelId)
  if (!judgeConfig) {
    throw new Error(`Missing judge model config for ${judgeModel.modelId}`)
  }
  const variantConfig = judgeConfig.qvac?.[judgeModel.quantization]
  if (!variantConfig) {
    throw new Error(`Missing judge variant ${judgeModel.quantization} for ${judgeModel.modelId}`)
  }
  const [modelName, modelDir] = await ensureModel({
    modelName: variantConfig.modelName,
    downloadUrl: variantConfig.downloadUrl
  })

  const loader = new FilesystemDL({ dirPath: modelDir })
  const AddonClass = resolveAddonModule(args.addon)
  const judge = new AddonClass({
    loader,
    modelName,
    diskPath: modelDir,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    opts: { stats: false }
  }, {
    device: 'gpu',
    verbosity: '0',
    n_predict: '256',
    temp: '0.1',
    seed: '42'
  })

  let outputPath = args.output || args.input.replace('.jsonl', '.judged.jsonl')
  try {
    await judge.load()

    const rows = readJsonl(args.input)
    const cache = new Map()

    for (const row of rows) {
      if (!row.outputText || !row.promptText) {
        continue
      }
      const key = `${row.promptId}:${hashText(row.outputText)}`
      if (cache.has(key)) {
        const cached = cache.get(key)
        row.accuracyScore = cached.score
        row.accuracyReason = cached.reason
        continue
      }
      const response = await judge.run(buildJudgePrompt(row.promptText, row.outputText))
      const chunks = []
      await response.onUpdate(data => chunks.push(data)).await()
      const outputText = chunks.join('')
      const parsed = parseJudgeResponse(outputText)
      cache.set(key, parsed)
      row.accuracyScore = parsed.score
      row.accuracyReason = parsed.reason
    }

    writeJsonl(outputPath, rows)
    console.log(`✅ Wrote judged results to ${outputPath}`)
  } finally {
    await judge.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
}

run().catch(err => {
  console.error('❌ Error:', err)
  if (bareProcess?.exit) bareProcess.exit(1)
})
