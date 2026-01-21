'use strict'

const { spawnSync } = require('bare-subprocess')
const fs = require('bare-fs')
const path = require('bare-path')
const yaml = require('yaml')

// Paths relative to benchmarks/ (one level up from server/)
const BENCHMARKS_DIR = path.join(__dirname, '..')
const SHARED_DATA_DIR = path.join(BENCHMARKS_DIR, 'shared-data')
const ESPEAK_DATA_PATH = path.join(SHARED_DATA_DIR, 'espeak-ng-data')
const MODELS_PATH = path.join(SHARED_DATA_DIR, 'models')
const CONFIG_PATH = path.join(BENCHMARKS_DIR, 'client', 'config', 'config.yaml')

// Load configuration
let config
try {
  const configContent = fs.readFileSync(CONFIG_PATH, 'utf8')
  config = yaml.parse(configContent)
} catch (err) {
  console.error('Failed to load config.yaml:', err)
  process.exit(1)
}

// Google Drive file ID for eSpeak-ng data
const ESPEAK_GDRIVE_FILE_ID = '1lJgTw4_TO1BvRpZvmzTXzISCiZpL6wLo'

// Determine model name based on language
function getModelNameForLanguage (language) {
  const lang = (language || 'en-us').toLowerCase()

  switch (lang) {
    case 'en-us':
    case 'en':
      return 'en_US-lessac-medium'

    case 'es-es':
    case 'es':
      return 'es_ES-davefx-medium'

    case 'de-de':
    case 'de':
      return 'de_DE-thorsten-medium'

    case 'it-it':
    case 'it':
      return 'it_IT-paola-medium'

    case 'fr-fr':
    case 'fr':
      return 'fr_FR-siwis-medium'
    
    case 'hi-in':
    case 'hi':
      return 'hi_IN-rohan-medium'

    case 'ar-jo':
    case 'ar':
      return 'ar_JO-kareem-medium'

    case 'bg-bg':
    case 'bg':
      return 'bg_BG-dimitar-medium'

    case 'ca-es':
    case 'ca':
      return 'ca_ES-upc_ona-medium'
    
    case 'cs-cz':
    case 'cs':
      return 'cs_CZ-jirka-medium'

    case 'cy-gb':
    case 'cy':
      return 'cy_GB-gwryw_gogleddol-medium'
    
    case 'da-dk':
    case 'da':
      return 'da_DK-talesyntese-medium'

    case 'el-gr':
    case 'el':
      return 'el_GR-rapunzelina-medium'
    
    case 'fa-ir':
    case 'fa':
      return 'fa_IR-reza_ibrahim-medium'

    case 'fi-fi':
    case 'fi':
      return 'fi_FI-harri-medium'

    case 'hu-hu':
    case 'hu':
      return 'hu_HU-imre-medium'

    case 'id-id':
    case 'id':
      return 'id_ID-news_tts-medium'

    case 'is-is':
    case 'is':
      return 'is_IS-ugla-medium'

    case 'ka-ge':
    case 'ka':
      return 'ka_GE-natia-medium'

    case 'kk-kz':
    case 'kk':
      return 'kk_KZ-issai-high'
    
    case 'lb-lu':
    case 'lb':
      return 'lb_LU-marylux-medium'
    
    case 'lv-lv':
    case 'lv':
      return 'lv_LV-aivars-medium'
    
    case 'ml-in':
    case 'ml':
      return 'ml_IN-meera-medium'

    case 'ne-np':
    case 'ne':
      return 'ne_NP-chitwan-medium'

    case 'nl-be':
      return 'nl_BE-nathalie-medium'

    case 'nl-nl':
    case 'nl':
      return 'nl_NL-ronnie-medium'

    case 'no-no':
    case 'no':
    case 'nb-no':
    case 'nb':
      return 'no_NO-talesyntese-medium'

    case 'pl-pl':
    case 'pl':
      return 'pl_PL-gosia-medium'

    case 'pt-br':
      return 'pt_BR-jeff-medium'

    case 'pt-pt':
      return 'pt_PT-tugão-medium'

    case 'ro-ro':
    case 'ro':
      return 'ro_RO-mihai-medium'

    case 'ru-ru':
    case 'ru':
      return 'ru_RU-dmitri-medium'

    case 'sk-sk':
    case 'sk':
      return 'sk_SK-lili-medium'

    case 'sl-si':
    case 'sl':
      return 'sl_SI-artur-medium'

    case 'sr-rs':
    case 'sr':
      return 'sr_RS-serbski_institut-medium'

    case 'sv-se':
    case 'sv':
      return 'sv_SE-lisa-medium'

    case 'sw-cd':
    case 'sw':
      return 'sw_CD-lanfrica-medium'

    case 'te-in':
    case 'te':
      return 'te_IN-padmavathi-medium'

    case 'tr-tr':
    case 'tr':
      return 'tr_TR-dfki-medium'

    case 'uk-ua':
    case 'uk':
      return 'uk_UA-ukrainian_tts-medium'

    case 'vi-vn':
    case 'vi':
      return 'vi_VN-vais1000-medium'

    case 'zh-cn':
    case 'zh':
    case 'cmn':
      return 'zh_CN-huayan-medium'

    default:
      console.warn(`Warning: Unknown language '${language}', defaulting to English model`)
      return 'en_US-lessac-medium'
  }
}

const MODEL_NAME = config.model?.name || getModelNameForLanguage(config.model?.language)

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
async function downloadFileFromUrl (url, filepath) {
  const isJson = filepath.endsWith('.json')

  // Ensure the directory exists
  const dir = path.dirname(filepath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // Get expected file size from URL
  const expectedSize = getFileSizeFromUrl(url)
  const minSize = expectedSize ? Math.floor(expectedSize * 0.9) : (isJson ? 100 : 1000000)

  if (fs.existsSync(filepath)) {
    const stats = fs.statSync(filepath)
    if (stats.size >= minSize) {
      console.log(` ✓ Using cached file: ${path.basename(filepath)} (${stats.size} bytes)`)
      return { success: true, path: filepath }
    } else {
      console.log(` Cached file too small (${stats.size} bytes), re-downloading...`)
      fs.unlinkSync(filepath)
    }
  }

  console.log(` Downloading: ${path.basename(filepath)}...`)
  if (expectedSize) {
    console.log(` Expected size: ${expectedSize} bytes`)
  }

  try {
    // For JSON files, fetch content and write to file
    if (isJson) {
      const result = spawnSync('curl', [
        '-L', url,
        '--fail', '--silent', '--show-error',
        '--connect-timeout', '30',
        '--max-time', '300'
      ], { stdio: ['inherit', 'pipe', 'pipe'] })

      if (result.status === 0 && result.stdout) {
        fs.writeFileSync(filepath, result.stdout)
        const stats = fs.statSync(filepath)
        if (stats.size >= minSize) {
          console.log(` ✓ Downloaded: ${path.basename(filepath)} (${stats.size} bytes)`)
          return { success: true, path: filepath }
        } else {
          console.log(` Downloaded file too small: ${stats.size} bytes (expected >${minSize})`)
        }
      } else {
        console.log(` Download failed with exit code: ${result.status}`)
      }
    } else {
      // For binary files (.onnx), download directly to file
      const result = spawnSync('curl', [
        '-L', '-o', filepath, url,
        '--fail', '--silent', '--show-error',
        '--connect-timeout', '30',
        '--max-time', '300'
      ], { stdio: ['inherit', 'inherit', 'pipe'] })

      if (result.status === 0 && fs.existsSync(filepath)) {
        const stats = fs.statSync(filepath)
        if (stats.size >= minSize) {
          console.log(` ✓ Downloaded: ${path.basename(filepath)} (${stats.size} bytes)`)
          return { success: true, path: filepath }
        } else {
          console.log(` Downloaded file too small: ${stats.size} bytes (expected >${minSize})`)
        }
      } else {
        console.log(` Download failed with exit code: ${result.status}`)
      }
    }
  } catch (e) {
    console.log(` Download error: ${e.message}`)
  }

  throw new Error(`Failed to download ${path.basename(filepath)} from ${url}`)
}

/**
 * Download TTS model pair (.onnx and .json) from Hugging Face
 */
async function downloadTTSModel (modelName, destPath) {
  console.log(`\n>>> Downloading TTS Model: ${modelName}...`)

  // Parse model name to construct HuggingFace URLs
  // Format: locale-voice-quality (e.g., en_US-lessac-medium)
  const parts = modelName.split('-')
  const locale = parts[0]
  const voice = parts[1]
  const quality = parts.slice(2).join('-')

  const [language] = locale.split('_')

  const baseUrl = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${language}/${locale}/${voice}/${quality}`
  const onnxUrl = `${baseUrl}/${modelName}.onnx`
  const jsonUrl = `${baseUrl}/${modelName}.onnx.json`

  const onnxPath = path.join(destPath, `${modelName}.onnx`)
  const jsonPath = path.join(destPath, `${modelName}.onnx.json`)

  // Download .onnx file
  const onnxResult = await downloadFileFromUrl(onnxUrl, onnxPath)

  // Download .json file
  const jsonResult = await downloadFileFromUrl(jsonUrl, jsonPath)

  console.log('>>> TTS Model download complete')

  return {
    onnx: onnxResult,
    json: jsonResult,
    success: onnxResult.success && jsonResult.success
  }
}

/**
 * Download and unzip file from Google Drive
 */
async function downloadAndUnzipFromGoogleDrive (fileId, destPath, label) {
  console.log(`\n>>> Downloading ${label} from Google Drive...`)

  // Check if destination already has content
  if (fs.existsSync(destPath)) {
    const contents = fs.readdirSync(destPath)
    if (contents.length > 0) {
      console.log(`>>> [${label}] Using cached data (${contents.length} items found)`)
      return
    }
  }

  // Create destination directory
  fs.mkdirSync(destPath, { recursive: true })

  const zipPath = path.join(destPath, '..', `${label.replace(/\s+/g, '-').toLowerCase()}.zip`)
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`

  console.log(`>>> [${label}] Downloading zip file...`)

  // Download the zip file using curl
  // For large files, Google Drive may require confirmation - use confirm parameter
  const result = spawnSync('curl', [
    '-L',
    '-o', zipPath,
    `${downloadUrl}&confirm=t`,
    '--fail',
    '--show-error',
    '--connect-timeout', '30',
    '--max-time', '600'
  ], { stdio: ['inherit', 'inherit', 'pipe'] })

  if (result.status !== 0) {
    throw new Error(`Failed to download ${label} from Google Drive. Exit code: ${result.status}`)
  }

  if (!fs.existsSync(zipPath)) {
    throw new Error(`Download failed - zip file not found at ${zipPath}`)
  }

  const zipStats = fs.statSync(zipPath)
  console.log(`>>> [${label}] Downloaded zip file (${zipStats.size} bytes)`)

  // Unzip the file
  console.log(`>>> [${label}] Extracting zip file...`)
  const unzipResult = spawnSync('unzip', [
    '-o',
    '-q',
    zipPath,
    '-d', destPath
  ], { stdio: ['inherit', 'inherit', 'pipe'] })

  if (unzipResult.status !== 0) {
    throw new Error(`Failed to extract ${label}. Exit code: ${unzipResult.status}`)
  }

  // Clean up the zip file
  console.log(`>>> [${label}] Cleaning up zip file...`)
  fs.unlinkSync(zipPath)

  const extractedContents = fs.readdirSync(destPath)
  console.log(`>>> [${label}] Complete: ${extractedContents.length} items extracted`)
}

/**
 * Main setup function
 */
async function setup () {
  console.log('=================================================')
  console.log('    TTS Benchmark Setup')
  console.log('=================================================')
  console.log(`Shared data directory: ${SHARED_DATA_DIR}`)
  console.log(`Language: ${config.model?.language || 'en-us'}`)
  console.log(`Model name: ${MODEL_NAME}\n`)

  // Create directories
  console.log('Creating directories...')
  fs.mkdirSync(SHARED_DATA_DIR, { recursive: true })
  fs.mkdirSync(ESPEAK_DATA_PATH, { recursive: true })
  fs.mkdirSync(MODELS_PATH, { recursive: true })
  console.log('✓ Directories created')

  // Download eSpeak-ng data (from Google Drive)
  await downloadAndUnzipFromGoogleDrive(ESPEAK_GDRIVE_FILE_ID, ESPEAK_DATA_PATH, 'eSpeak-ng Data')

  // Download TTS models (from Hugging Face)
  await downloadTTSModel(MODEL_NAME, MODELS_PATH)

  console.log('\n=================================================')
  console.log('    Setup Complete!')
  console.log('=================================================')
  console.log(`eSpeak data: ${ESPEAK_DATA_PATH}`)
  console.log(`Models: ${MODELS_PATH}`)
  console.log('\nNext steps:')
  console.log('  1. Start Node.js server:  npm start')
  console.log('  2. Start Python server:   cd ../python-server && python main.py')
  console.log('  3. Run benchmark:         cd ../client && python -m src.tts.main')
  console.log('=================================================\n')
}

setup().catch(err => {
  console.error('\n❌ Setup failed:', err)
  process.exit(1)
})
