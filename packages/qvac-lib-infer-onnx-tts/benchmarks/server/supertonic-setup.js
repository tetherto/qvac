'use strict'

const { spawnSync } = require('bare-subprocess')
const fs = require('bare-fs')
const path = require('bare-path')
const yaml = require('yaml')

// Paths relative to benchmarks/ (one level up from server/)
const BENCHMARKS_DIR = path.join(__dirname, '..')
const SHARED_DATA_DIR = path.join(BENCHMARKS_DIR, 'shared-data')
const MODELS_ENGLISH_PATH = path.join(SHARED_DATA_DIR, 'models', 'supertonic-v1')
const MODELS_MULTILINGUAL_PATH = path.join(SHARED_DATA_DIR, 'models', 'supertonic-multilingual')
const CONFIG_PATH = path.join(BENCHMARKS_DIR, 'client', 'config', 'config-supertonic.yaml')
const BASE_URL_ENGLISH = 'https://huggingface.co/Supertone/supertonic/resolve/main'
const BASE_URL_MULTILINGUAL = 'https://huggingface.co/Supertone/supertonic-2/resolve/main'

// Load configuration
let config
try {
  const configContent = fs.readFileSync(CONFIG_PATH, 'utf8')
  config = yaml.parse(configContent)
} catch (err) {
  console.error('Failed to load config-supertonic.yaml:', err)
  process.exit(1)
}

const VOICE_NAME = (config.model?.voiceName || 'F1').replace(/\.(bin|json)$/i, '')

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
async function downloadFileFromUrl (url, filepath, minSize = 1000, relRoot = null) {
  const relBase = relRoot != null ? relRoot : path.dirname(filepath)
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
      console.log(` ✓ Using cached file: ${path.relative(relBase, filepath)} (${stats.size} bytes)`)
      return { success: true, path: filepath }
    }
    console.log(` Cached file too small (${stats.size} bytes), re-downloading...`)
    fs.unlinkSync(filepath)
  }

  console.log(` Downloading: ${path.relative(relBase, filepath)}...`)
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
      console.log(` ✓ Downloaded: ${path.relative(relBase, filepath)} (${stats.size} bytes)`)
      return { success: true, path: filepath }
    }
    console.log(` Downloaded file too small: ${stats.size} bytes (expected >${effectiveMinSize})`)
  } else {
    console.log(` Download failed with exit code: ${result.status}`)
  }
  throw new Error(`Failed to download ${path.basename(filepath)} from ${url}`)
}

/**
 * Download Supertone supertonic bundle (English or multilingual HF supertonic-2) from Hugging Face.
 */
async function downloadSupertonicBundle (destPath, voiceName, baseUrl, label) {
  console.log(`\n>>> Downloading Supertone supertonic ${label} (voice: ${voiceName})...`)

  const onnxDir = path.join(destPath, 'onnx')
  const voiceStylesDir = path.join(destPath, 'voice_styles')
  fs.mkdirSync(onnxDir, { recursive: true })
  fs.mkdirSync(voiceStylesDir, { recursive: true })

  const onnxFiles = [
    { name: 'duration_predictor.onnx', minSize: 1_000_000 },
    { name: 'text_encoder.onnx', minSize: 1_000_000 },
    { name: 'vector_estimator.onnx', minSize: 10_000_000 },
    { name: 'vocoder.onnx', minSize: 10_000_000 },
    { name: 'tts.json', minSize: 1000 },
    { name: 'unicode_indexer.json', minSize: 100_000 }
  ]

  const results = []
  const relRoot = destPath

  for (const file of onnxFiles) {
    const url = `${baseUrl}/onnx/${file.name}`
    const filepath = path.join(onnxDir, file.name)
    try {
      const r = await downloadFileFromUrl(url, filepath, file.minSize, relRoot)
      results.push(r)
    } catch (err) {
      console.error(` ✗ Failed to download onnx/${file.name}: ${err.message}`)
      results.push({ success: false, path: filepath })
    }
  }

  const voiceFile = `${voiceName.replace(/\.json$/i, '')}.json`
  const voiceUrl = `${baseUrl}/voice_styles/${voiceFile}`
  const voicePath = path.join(voiceStylesDir, voiceFile)
  try {
    const r = await downloadFileFromUrl(voiceUrl, voicePath, 100_000, relRoot)
    results.push(r)
  } catch (err) {
    console.error(` ✗ Failed to download voice_styles/${voiceFile}: ${err.message}`)
    results.push({ success: false, path: voicePath })
  }

  const allSuccess = results.every(r => r.success)
  console.log(`>>> Supertone supertonic ${label} download complete`)
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
  fs.mkdirSync(MODELS_ENGLISH_PATH, { recursive: true })
  fs.mkdirSync(MODELS_MULTILINGUAL_PATH, { recursive: true })
  console.log('✓ Directories created')

  await downloadSupertonicBundle(MODELS_ENGLISH_PATH, VOICE_NAME, BASE_URL_ENGLISH, 'English (HF supertonic)')
  await downloadSupertonicBundle(MODELS_MULTILINGUAL_PATH, VOICE_NAME, BASE_URL_MULTILINGUAL, 'multilingual (HF supertonic-2)')

  console.log('\n=================================================')
  console.log('    Setup Complete!')
  console.log('=================================================')
  console.log(`Models English benchmark (HF supertonic): ${MODELS_ENGLISH_PATH}`)
  console.log(`Models multilingual (HF supertonic-2): ${MODELS_MULTILINGUAL_PATH}`)
  console.log('\nNext steps:')
  console.log('  1. Start Node.js server:  npm start')
  console.log('  2. Run benchmark:         cd ../client && python -m src.tts.main --config config/config-supertonic.yaml')
  console.log('=================================================\n')
}

setup().catch(err => {
  console.error('\n❌ Setup failed:', err)
  process.exit(1)
})
