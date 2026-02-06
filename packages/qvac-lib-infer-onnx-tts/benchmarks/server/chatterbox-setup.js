'use strict'

const { spawnSync } = require('bare-subprocess')
const fs = require('bare-fs')
const path = require('bare-path')
const yaml = require('yaml')

// Paths: script is in benchmarks/server/
const BENCHMARKS_DIR = path.join(__dirname, '..')
const SHARED_DATA_DIR = path.join(BENCHMARKS_DIR, 'shared-data')
const MODELS_PATH = path.join(SHARED_DATA_DIR, 'models', 'chatterbox')
const CONFIG_PATH = path.join(BENCHMARKS_DIR, 'client', 'config', 'config-chatterbox.yaml')

let config
try {
  const configContent = fs.readFileSync(CONFIG_PATH, 'utf8')
  config = yaml.parse(configContent)
} catch (err) {
  console.error('Failed to load config-chatterbox.yaml:', err)
  process.exit(1)
}

const VARIANT = config.model?.variant || 'fp32'

const BASE_URL = 'https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX/resolve/main/onnx'
const TOKENIZER_URL = 'https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX/resolve/main/tokenizer.json'

function getFileSizeFromUrl (url) {
  try {
    const result = spawnSync('curl', [
      '-I', '-L', url,
      '--fail', '--silent', '--show-error',
      '--connect-timeout', '10',
      '--max-time', '30'
    ], { stdio: ['inherit', 'pipe', 'pipe'] })

    if (result.status === 0 && result.stdout) {
      const output = result.stdout.toString()
      const match = output.match(/content-length:\s*(\d+)/i)
      if (match) {
        return parseInt(match[1], 10)
      }
    }
  } catch (e) {
    console.log(` Warning: Could not get file size from URL: ${e.message}`)
  }
  return null
}

async function downloadFileFromUrl (url, filepath, minSize = 1000) {
  const isJson = filepath.endsWith('.json')
  const dir = path.dirname(filepath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const expectedSize = getFileSizeFromUrl(url)
  const effectiveMinSize = expectedSize ? Math.floor(expectedSize * 0.9) : minSize

  if (fs.existsSync(filepath)) {
    const stats = fs.statSync(filepath)
    if (stats.size >= effectiveMinSize) {
      console.log(` ✓ Using cached file: ${path.basename(filepath)} (${stats.size} bytes)`)
      return { success: true, path: filepath }
    }
    console.log(` Cached file too small (${stats.size} bytes), re-downloading...`)
    fs.unlinkSync(filepath)
  }

  console.log(` Downloading: ${path.basename(filepath)}...`)
  if (expectedSize) {
    console.log(` Expected size: ${expectedSize} bytes`)
  }

  const maxTime = isJson ? '300' : '1800'
  const result = spawnSync('curl', [
    '-L', '-o', filepath, url,
    '--fail', '--silent', '--show-error',
    '--connect-timeout', '30',
    '--max-time', maxTime
  ], { stdio: ['inherit', 'inherit', 'pipe'] })

  if (result.status === 0 && fs.existsSync(filepath)) {
    const stats = fs.statSync(filepath)
    if (stats.size >= effectiveMinSize) {
      console.log(` ✓ Downloaded: ${path.basename(filepath)} (${stats.size} bytes)`)
      return { success: true, path: filepath }
    }
    console.log(` Downloaded file too small: ${stats.size} bytes (expected >${effectiveMinSize})`)
  } else {
    console.log(` Download failed with exit code: ${result.status}`)
  }

  throw new Error(`Failed to download ${path.basename(filepath)} from ${url}`)
}

async function downloadChatterboxModels (variant, destPath) {
  console.log(`\n>>> Downloading Chatterbox Models (variant: ${variant})...`)

  const suffix = variant === 'fp32' ? '' : `_${variant}`

  const modelFiles = [
    { name: `speech_encoder${suffix}.onnx`, targetName: 'speech_encoder.onnx', minSize: 1000 },
    { name: `speech_encoder${suffix}.onnx_data`, targetName: 'speech_encoder.onnx_data', minSize: 100000000 },
    { name: `embed_tokens${suffix}.onnx`, targetName: 'embed_tokens.onnx', minSize: 1000 },
    { name: `embed_tokens${suffix}.onnx_data`, targetName: 'embed_tokens.onnx_data', minSize: 10000000 },
    { name: `conditional_decoder${suffix}.onnx`, targetName: 'conditional_decoder.onnx', minSize: 1000 },
    { name: `conditional_decoder${suffix}.onnx_data`, targetName: 'conditional_decoder.onnx_data', minSize: 100000000 },
    { name: `language_model${suffix}.onnx`, targetName: 'language_model.onnx', minSize: 100000 },
    { name: `language_model${suffix}.onnx_data`, targetName: 'language_model.onnx_data', minSize: 100000000 }
  ]

  if (variant === 'fp16') {
    modelFiles[1].minSize = 50000000
    modelFiles[3].minSize = 5000000
    modelFiles[5].minSize = 50000000
    modelFiles[7].minSize = 50000000
  } else if (variant === 'q4' || variant === 'quantized') {
    modelFiles[1].minSize = 20000000
    modelFiles[3].minSize = 2000000
    modelFiles[5].minSize = 20000000
    modelFiles[7].minSize = 20000000
  }

  const results = []

  for (const file of modelFiles) {
    const url = `${BASE_URL}/${file.name}`
    const filepath = path.join(destPath, file.targetName)
    try {
      const result = await downloadFileFromUrl(url, filepath, file.minSize)
      results.push(result)
    } catch (err) {
      console.error(` ✗ Failed to download ${file.name}: ${err.message}`)
      results.push({ success: false, path: filepath })
    }
  }

  const tokenizerPath = path.join(destPath, 'tokenizer.json')
  try {
    const tokenizerResult = await downloadFileFromUrl(TOKENIZER_URL, tokenizerPath, 3000000)
    results.push(tokenizerResult)
  } catch (err) {
    console.error(` ✗ Failed to download tokenizer.json: ${err.message}`)
    results.push({ success: false, path: tokenizerPath })
  }

  const allSuccess = results.every(r => r.success)
  console.log('>>> Chatterbox Models download complete')

  return { results, success: allSuccess }
}

async function setup () {
  console.log('=================================================')
  console.log('    Chatterbox TTS Benchmark Setup')
  console.log('=================================================')
  console.log(`Shared data directory: ${SHARED_DATA_DIR}`)
  console.log(`Model variant: ${VARIANT}`)
  console.log(`Language: en (Chatterbox is English-only)\n`)

  console.log('Creating directories...')
  fs.mkdirSync(SHARED_DATA_DIR, { recursive: true })
  fs.mkdirSync(MODELS_PATH, { recursive: true })
  console.log('✓ Directories created')

  await downloadChatterboxModels(VARIANT, MODELS_PATH)

  console.log('\n=================================================')
  console.log('    Setup Complete!')
  console.log('=================================================')
  console.log(`Models: ${MODELS_PATH}`)
  console.log('\nNext steps:')
  console.log('  1. Start Node.js server:  npm start')
  console.log('  2. Run benchmark:         cd ../client && python -m src.tts.main --config config/config-chatterbox.yaml')
  console.log('=================================================\n')
}

setup().catch(err => {
  console.error('\n❌ Setup failed:', err)
  process.exit(1)
})
