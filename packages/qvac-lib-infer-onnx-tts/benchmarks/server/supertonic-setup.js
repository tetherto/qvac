'use strict'

const { spawnSync } = require('bare-subprocess')
const fs = require('bare-fs')
const path = require('bare-path')
const yaml = require('yaml')

// Paths relative to benchmarks/ (one level up from server/)
const BENCHMARKS_DIR = path.join(__dirname, '..')
const SHARED_DATA_DIR = path.join(BENCHMARKS_DIR, 'shared-data')
const MODELS_PATH = path.join(SHARED_DATA_DIR, 'models', 'supertonic')
const CONFIG_PATH = path.join(BENCHMARKS_DIR, 'client', 'config', 'config-supertonic.yaml')

// Load configuration
let config
try {
  const configContent = fs.readFileSync(CONFIG_PATH, 'utf8')
  config = yaml.parse(configContent)
} catch (err) {
  console.error('Failed to load config-supertonic.yaml:', err)
  process.exit(1)
}

const VOICE_NAME = (config.model?.voiceName || 'F1').replace(/\.bin$/, '')
const BASE_URL = 'https://huggingface.co/onnx-community/Supertonic-TTS-ONNX/resolve/main'

/**
 * Get file size from URL
 */
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

/**
 * Download a file from URL using curl
 */
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
      console.log(` ✓ Using cached file: ${path.relative(MODELS_PATH, filepath)} (${stats.size} bytes)`)
      return { success: true, path: filepath }
    }
    console.log(` Cached file too small (${stats.size} bytes), re-downloading...`)
    fs.unlinkSync(filepath)
  }

  console.log(` Downloading: ${path.relative(MODELS_PATH, filepath)}...`)
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
      console.log(` ✓ Downloaded: ${path.relative(MODELS_PATH, filepath)} (${stats.size} bytes)`)
      return { success: true, path: filepath }
    }
    console.log(` Downloaded file too small: ${stats.size} bytes (expected >${effectiveMinSize})`)
  } else {
    console.log(` Download failed with exit code: ${result.status}`)
  }
  throw new Error(`Failed to download ${path.basename(filepath)} from ${url}`)
}

/**
 * Download Supertonic model files from Hugging Face
 * https://huggingface.co/onnx-community/Supertonic-TTS-ONNX
 */
async function downloadSupertonicModels (destPath, voiceName) {
  console.log(`\n>>> Downloading Supertonic Models (voice: ${voiceName})...`)

  const onnxDir = path.join(destPath, 'onnx')
  const voicesDir = path.join(destPath, 'voices')
  fs.mkdirSync(onnxDir, { recursive: true })
  fs.mkdirSync(voicesDir, { recursive: true })

  const onnxFiles = [
    { name: 'text_encoder.onnx', minSize: 100000 },
    { name: 'text_encoder.onnx_data', minSize: 25000000 },
    { name: 'latent_denoiser.onnx', minSize: 100000 },
    { name: 'latent_denoiser.onnx_data', minSize: 120000000 },
    { name: 'voice_decoder.onnx', minSize: 10000 },
    { name: 'voice_decoder.onnx_data', minSize: 95000000 }
  ]

  const results = []

  for (const file of onnxFiles) {
    const url = `${BASE_URL}/onnx/${file.name}`
    const filepath = path.join(onnxDir, file.name)
    try {
      const r = await downloadFileFromUrl(url, filepath, file.minSize)
      results.push(r)
    } catch (err) {
      console.error(` ✗ Failed to download onnx/${file.name}: ${err.message}`)
      results.push({ success: false, path: filepath })
    }
  }

  const voiceFile = voiceName.endsWith('.bin') ? voiceName : `${voiceName}.bin`
  const voiceUrl = `${BASE_URL}/voices/${voiceFile}`
  const voicePath = path.join(voicesDir, voiceFile)
  try {
    const r = await downloadFileFromUrl(voiceUrl, voicePath, 40000)
    results.push(r)
  } catch (err) {
    console.error(` ✗ Failed to download voices/${voiceFile}: ${err.message}`)
    results.push({ success: false, path: voicePath })
  }

  const tokenizerUrl = `${BASE_URL}/tokenizer.json`
  const tokenizerPath = path.join(destPath, 'tokenizer.json')
  try {
    const r = await downloadFileFromUrl(tokenizerUrl, tokenizerPath, 1000)
    results.push(r)
  } catch (err) {
    console.error(` ✗ Failed to download tokenizer.json: ${err.message}`)
    results.push({ success: false, path: tokenizerPath })
  }

  const tokenizerConfigUrl = `${BASE_URL}/tokenizer_config.json`
  const tokenizerConfigPath = path.join(destPath, 'tokenizer_config.json')
  try {
    const r = await downloadFileFromUrl(tokenizerConfigUrl, tokenizerConfigPath, 50)
    results.push(r)
  } catch (err) {
    console.error(` ✗ Failed to download tokenizer_config.json: ${err.message}`)
    results.push({ success: false, path: tokenizerConfigPath })
  }

  const allSuccess = results.every(r => r.success)
  console.log('>>> Supertonic models download complete')
  return { results, success: allSuccess }
}

async function setup () {
  console.log('=================================================')
  console.log('    Supertonic TTS Benchmark Setup')
  console.log('=================================================')
  console.log(`Shared data directory: ${SHARED_DATA_DIR}`)
  console.log(`Voice: ${VOICE_NAME}`)
  console.log(`Config: ${CONFIG_PATH}`)
  console.log('')

  console.log('Creating directories...')
  fs.mkdirSync(SHARED_DATA_DIR, { recursive: true })
  fs.mkdirSync(MODELS_PATH, { recursive: true })
  console.log('✓ Directories created')

  await downloadSupertonicModels(MODELS_PATH, VOICE_NAME)

  console.log('\n=================================================')
  console.log('    Setup Complete!')
  console.log('=================================================')
  console.log(`Models: ${MODELS_PATH}`)
  console.log('\nNext steps:')
  console.log('  1. Start Node.js server:  npm start')
  console.log('  2. Run benchmark:         cd ../client && python -m src.tts.main --config config/config-supertonic.yaml')
  console.log('=================================================\n')
}

setup().catch(err => {
  console.error('\n❌ Setup failed:', err)
  process.exit(1)
})
