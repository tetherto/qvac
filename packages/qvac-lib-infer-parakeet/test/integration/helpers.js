'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const { Readable } = require('bare-stream')
const { spawn } = require('bare-subprocess')
const TranscriptionParakeet = require('../../index.js')

const platform = os.platform()
const arch = os.arch()
const isMobile = platform === 'ios' || platform === 'android'

let FakeDL = null
if (!isMobile) {
  try {
    FakeDL = require('../mocks/loader.fake.js')
  } catch (e) {}
}

/**
 * Detect current platform
 * @returns {string} Platform string (e.g., 'linux-x64', 'darwin-arm64')
 */
function detectPlatform () {
  return `${platform}-${arch}`
}

/**
 * Wait until model reaches idle state
 * @param {Object} model - TranscriptionParakeet instance
 * @param {number} [maxMs=30000] - Maximum wait time in milliseconds
 * @returns {Promise<boolean>} True if idle state reached
 */
async function waitUntilIdle (model, maxMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const s = await model.status()
      if (s === 'IDLE') return true
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

/**
 * Converts various audio input types to a Readable stream
 * @param {string|Buffer|Uint8Array|Float32Array|Readable} audioInput - Audio input in various formats
 * @returns {Readable} Readable stream
 */
function createAudioStream (audioInput) {
  if (typeof audioInput === 'string') {
    const audioBuffer = fs.readFileSync(audioInput)
    // Create stream from Buffer with chunking to simulate streaming behavior
    const chunkSize = 16384 // 16KB chunks
    const chunks = []
    for (let i = 0; i < audioBuffer.length; i += chunkSize) {
      const chunk = audioBuffer.slice(i, i + chunkSize)
      chunks.push(new Uint8Array(chunk))
    }
    return Readable.from(chunks)
  } else if (Buffer.isBuffer(audioInput) || audioInput instanceof Uint8Array) {
    return Readable.from([audioInput])
  } else if (audioInput instanceof Float32Array) {
    // Convert Float32Array to Buffer for streaming
    const buffer = Buffer.from(audioInput.buffer)
    return Readable.from([buffer])
  } else if (Array.isArray(audioInput)) {
    return Readable.from(audioInput)
  } else if (audioInput && typeof audioInput.read === 'function') {
    return audioInput
  } else {
    throw new Error(`Unsupported audio input type: ${typeof audioInput}`)
  }
}

/**
 * Calculate audio duration in milliseconds from audio buffer
 * @param {Buffer|Uint8Array|Float32Array} audioBuffer - Audio data buffer
 * @param {string} audioFormat - Audio format ('f32le' or 's16le')
 * @param {number} sampleRate - Sample rate in Hz (default: 16000)
 * @returns {number} Duration in milliseconds
 */
function calculateAudioDuration (audioBuffer, audioFormat = 'f32le', sampleRate = 16000) {
  let bytesPerSample
  if (audioFormat === 's16le') {
    bytesPerSample = 2
  } else if (audioFormat === 'f32le') {
    bytesPerSample = 4
  } else {
    bytesPerSample = 4 // Default to f32le
  }

  const numSamples = audioBuffer.length / bytesPerSample
  const durationSeconds = numSamples / sampleRate
  return durationSeconds * 1000
}

/**
 * Generates a test audio file with a sine wave tone (Float32 format for Parakeet)
 * @param {string} filepath - Path where the audio file should be created
 * @param {number} [sampleRate=16000] - Sample rate in Hz
 * @param {number} [duration=3] - Duration in seconds
 * @param {number} [frequency=440] - Frequency in Hz (A4 note)
 * @param {number} [amplitude=0.3] - Amplitude (0-1)
 * @returns {string} The filepath of the generated audio file
 */
function generateTestAudio (filepath, sampleRate = 16000, duration = 3, frequency = 440, amplitude = 0.3) {
  if (fs.existsSync(filepath)) return filepath

  const samples = sampleRate * duration
  const audioData = new Float32Array(samples)

  for (let i = 0; i < samples; i++) {
    audioData[i] = Math.sin(2 * Math.PI * frequency * i / sampleRate) * amplitude
  }

  const buffer = Buffer.from(audioData.buffer)
  fs.writeFileSync(filepath, buffer)
  return filepath
}

/**
 * Generates PCM noise for testing audio processing robustness (Float32 format)
 * @param {number} numSamples - Number of audio samples to generate
 * @param {number} [amplitude=0.3] - Maximum amplitude of noise
 * @returns {Float32Array} PCM noise data
 */
function makePcmNoise (numSamples, amplitude = 0.3) {
  const audioData = new Float32Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    audioData[i] = (Math.random() * 2 - 1) * amplitude
  }
  return audioData
}

/**
 * Sets up JavaScript logger for C++ bindings
 * @param {Object} [binding] - Optional binding instance (will require if not provided)
 * @returns {Object} The binding instance with logger configured
 */
function setupJsLogger (binding = null) {
  const actualBinding = binding || require('../../binding')
  // Logger lifecycle in integration can crash or hang when repeatedly toggled.
  // Keep release as a no-op and only enable native logging explicitly when requested.
  if (!actualBinding.__qvacReleaseLoggerPatched) {
    actualBinding.releaseLogger = () => {}
    actualBinding.__qvacReleaseLoggerPatched = true
  }

  const shouldEnableNativeLogs = process.env &&
    process.env.QVAC_TEST_NATIVE_LOGS === '1'

  if (shouldEnableNativeLogs && !actualBinding.__qvacLoggerSet) {
    const LOG_PRIORITIES = ['ERROR', 'WARNING', 'INFO', 'DEBUG']
    actualBinding.setLogger((priority, message) => {
      const priorityName = LOG_PRIORITIES[priority] || `UNKNOWN(${priority})`
      console.log(`[C++ ${priorityName}] ${message}`)
    })
    actualBinding.__qvacLoggerSet = true
  }

  return actualBinding
}

/**
 * Calculate Word Error Rate (WER) between expected and actual transcriptions
 * @param {string} expected - Expected/reference transcription
 * @param {string} actual - Actual/hypothesis transcription
 * @returns {number} WER as a decimal (0.0 = perfect, 1.0 = 100% error)
 */
function wordErrorRate (expected, actual) {
  const normalize = (text) => text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()

  const r = normalize(expected).split(/\s+/).filter(w => w.length > 0)
  const h = normalize(actual).split(/\s+/).filter(w => w.length > 0)

  if (r.length === 0) {
    return h.length === 0 ? 0 : 1
  }

  const d = Array(r.length + 1).fill(null).map(() => Array(h.length + 1).fill(0))

  for (let i = 0; i <= r.length; i++) d[i][0] = i
  for (let j = 0; j <= h.length; j++) d[0][j] = j

  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      const cost = r[i - 1] === h[j - 1] ? 0 : 1
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      )
    }
  }

  return d[r.length][h.length] / r.length
}

/**
 * Validate transcription accuracy using Word Error Rate
 * @param {string} expected - Expected/reference transcription
 * @param {string} actual - Actual/hypothesis transcription
 * @param {number} [threshold=0.3] - Maximum acceptable WER (default 30%)
 * @returns {Object} Validation result with wer, passed, and details
 */
function validateAccuracy (expected, actual, threshold = 0.3) {
  const wer = wordErrorRate(expected, actual)
  const passed = wer <= threshold

  return {
    wer,
    werPercent: (wer * 100).toFixed(2) + '%',
    passed,
    threshold,
    thresholdPercent: (threshold * 100).toFixed(0) + '%',
    expected: expected.substring(0, 100) + (expected.length > 100 ? '...' : ''),
    actual: actual.substring(0, 100) + (actual.length > 100 ? '...' : '')
  }
}

/**
 * Gets standard test paths for models and audio files
 * @param {string} [modelsDir] - Optional models directory
 * @returns {Object} Object with modelsDir, samplesDir, modelPath, and audioPath
 */
function getTestPaths (modelsDir = null) {
  const writableRoot = global.testDir || (isMobile ? os.tmpdir() : null)

  let actualModelsDir, samplesDir

  if (isMobile && writableRoot) {
    actualModelsDir = modelsDir || path.join(writableRoot, 'models')
    samplesDir = path.join(writableRoot, 'samples')
  } else {
    actualModelsDir = modelsDir || path.resolve(__dirname, '../../models')
    samplesDir = path.resolve(__dirname, '../../examples/samples')
  }

  if (!fs.existsSync(actualModelsDir)) {
    fs.mkdirSync(actualModelsDir, { recursive: true })
  }
  if (!fs.existsSync(samplesDir)) {
    fs.mkdirSync(samplesDir, { recursive: true })
  }

  return {
    modelsDir: actualModelsDir,
    samplesDir,
    modelPath: path.join(actualModelsDir, 'parakeet-tdt-0.6b-v3-onnx'),
    audioPath: path.join(samplesDir, 'sample-16k.wav'),
    isMobile
  }
}

/**
 * Downloads a file from URL using curl
 * @param {string} url - URL to download from
 * @param {string} destPath - Destination file path
 * @returns {Promise<void>}
 */
async function downloadFile (url, destPath) {
  return new Promise((resolve, reject) => {
    const curl = spawn('curl', ['-L', '-o', destPath, url])
    curl.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`curl exited with code ${code}`))
    })
    curl.on('error', reject)
  })
}

/**
 * Ensures the TDT model is downloaded and available
 * Downloads from HuggingFace if not present
 * @param {string} [modelPath] - Optional model path (defaults to standard location)
 * @returns {Promise<string>} Path to the model directory
 */
async function ensureModel (modelPath = null) {
  const { modelsDir } = getTestPaths()
  const targetPath = modelPath || path.join(modelsDir, 'parakeet-tdt-0.6b-v3-onnx')

  // Check if model already exists with all required files
  const requiredFiles = [
    'encoder-model.onnx',
    'encoder-model.onnx.data',
    'decoder_joint-model.onnx',
    'vocab.txt',
    'preprocessor.onnx'
  ]

  const allFilesExist = requiredFiles.every(file =>
    fs.existsSync(path.join(targetPath, file))
  )

  if (allFilesExist) {
    console.log('Model already downloaded')
    return targetPath
  }

  console.log('Downloading TDT model from HuggingFace...')

  // Create model directory
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true })
  }

  const baseUrl = 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main'
  const preprocessorUrl = 'https://huggingface.co/ysdede/parakeet-tdt-0.6b-v2-onnx/resolve/main/nemo128.onnx'

  const downloads = [
    { url: `${baseUrl}/encoder-model.onnx`, file: 'encoder-model.onnx' },
    { url: `${baseUrl}/encoder-model.onnx.data`, file: 'encoder-model.onnx.data' },
    { url: `${baseUrl}/decoder_joint-model.onnx`, file: 'decoder_joint-model.onnx' },
    { url: `${baseUrl}/vocab.txt`, file: 'vocab.txt' },
    { url: preprocessorUrl, file: 'preprocessor.onnx' }
  ]

  for (const { url, file } of downloads) {
    const destPath = path.join(targetPath, file)
    if (!fs.existsSync(destPath)) {
      console.log(`  Downloading ${file}...`)
      await downloadFile(url, destPath)
    }
  }

  console.log('Model download complete')
  return targetPath
}

/**
 * Read file in chunks using streaming to handle large files on all platforms
 * @param {string} filePath - Path to file
 * @param {number} [chunkSize=67108864] - Chunk size in bytes (default 64MB)
 * @returns {Generator<Buffer>} Generator yielding file chunks
 */
function * readFileChunked (filePath, chunkSize = 64 * 1024 * 1024) {
  const stat = fs.statSync(filePath)
  const fileSize = stat.size
  const fd = fs.openSync(filePath, 'r')

  try {
    let offset = 0
    while (offset < fileSize) {
      const readSize = Math.min(chunkSize, fileSize - offset)
      const buffer = Buffer.alloc(readSize)
      fs.readSync(fd, buffer, 0, readSize, offset)
      yield buffer
      offset += readSize
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Run transcription using TranscriptionParakeet
 * @param {Object} params - Transcription parameters
 * @param {Object} [expectation={}] - Expectations for validation
 * @returns {Promise<Object>} Result object with passed, output, and data
 */
async function runTranscription (params, expectation = {}) {
  if (!params) {
    return {
      output: 'Error: Missing required parameter: params',
      passed: false,
      data: { error: 'Missing required parameter: params' }
    }
  }

  const { modelsDir } = getTestPaths()
  const defaultModelPath = path.join(modelsDir, 'parakeet-tdt-0.6b-v3-onnx')

  const modelPath = params.modelPath || defaultModelPath
  const modelDir = path.dirname(modelPath)
  const modelName = params.modelName || path.basename(modelPath)
  const diskPath = params.diskPath || modelDir
  const loader = params.loader || new FakeDL({})
  const parakeetConfig = params.parakeetConfig || {}

  const config = {
    path: modelPath,
    parakeetConfig: {
      modelType: parakeetConfig.modelType || 'tdt',
      maxThreads: parakeetConfig.maxThreads || 4,
      useGPU: parakeetConfig.useGPU || false,
      ...parakeetConfig
    }
  }

  const constructorArgs = {
    modelName,
    diskPath,
    loader
  }

  if (typeof modelPath === 'string' && !fs.existsSync(modelPath)) {
    return {
      output: `Error: Model directory not found: ${modelPath}`,
      passed: false,
      data: { error: `Model directory not found: ${modelPath}` }
    }
  }

  let model
  try {
    model = new TranscriptionParakeet(constructorArgs, config)
    await model._load()

    if (!params.audioInput) {
      return {
        output: 'Config validation passed - model loaded successfully',
        passed: true,
        data: {
          segments: [],
          segmentCount: 0,
          fullText: '',
          textLength: 0,
          durationMs: 0,
          stats: null
        }
      }
    }

    const audioStream = createAudioStream(params.audioInput)
    const response = await model.run(audioStream)

    const segments = []
    let jobStats = null

    await response
      .onUpdate((outputArr) => {
        const items = Array.isArray(outputArr) ? outputArr : [outputArr]
        segments.push(...items)
        if (params.onUpdate) {
          params.onUpdate(outputArr)
        }
      })
      .await()

    if (response.stats) {
      jobStats = response.stats
    }

    const fullText = segments
      .map(s => (s && s.text) ? s.text : '')
      .filter(t => t.trim().length > 0)
      .join(' ')
      .trim()
      .replace(/\s+/g, ' ')

    const textLength = fullText.length
    const segmentCount = segments.length

    let passed = true

    if (expectation.minSegments !== undefined && segmentCount < expectation.minSegments) {
      passed = false
    }
    if (expectation.maxSegments !== undefined && segmentCount > expectation.maxSegments) {
      passed = false
    }
    if (expectation.minTextLength !== undefined && textLength < expectation.minTextLength) {
      passed = false
    }
    if (expectation.expectedText !== undefined && !fullText.toLowerCase().includes(expectation.expectedText.toLowerCase())) {
      passed = false
    }

    const output = `Transcribed ${segmentCount} segments from audio`

    return {
      output,
      passed,
      data: {
        segments,
        segmentCount,
        fullText,
        textLength,
        stats: jobStats
      }
    }
  } catch (error) {
    return {
      output: `Error: ${error.message}`,
      passed: false,
      data: {
        error: error.message,
        segments: [],
        segmentCount: 0,
        fullText: '',
        textLength: 0,
        stats: null
      }
    }
  } finally {
    if (model) {
      try {
        await model.unload()
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

const MODEL_CONFIGS = {
  ctc: {
    dirName: 'parakeet-ctc-0.6b-onnx',
    files: [
      { url: 'https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/resolve/main/onnx/model.onnx', file: 'model.onnx' },
      { url: 'https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/resolve/main/onnx/model.onnx_data', file: 'model.onnx_data' },
      { url: 'https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/resolve/main/tokenizer.json', file: 'tokenizer.json' }
    ]
  },
  eou: {
    dirName: 'parakeet-eou-120m-v1-onnx',
    files: [
      { url: 'https://huggingface.co/altunenes/parakeet-rs/resolve/main/realtime_eou_120m-v1-onnx/encoder.onnx', file: 'encoder.onnx' },
      { url: 'https://huggingface.co/altunenes/parakeet-rs/resolve/main/realtime_eou_120m-v1-onnx/decoder_joint.onnx', file: 'decoder_joint.onnx' },
      { url: 'https://huggingface.co/altunenes/parakeet-rs/resolve/main/realtime_eou_120m-v1-onnx/tokenizer.json', file: 'tokenizer.json' }
    ]
  },
  sortformer: {
    dirName: 'sortformer-4spk-v2-onnx',
    files: [
      { url: 'https://huggingface.co/cgus/diar_streaming_sortformer_4spk-v2-onnx/resolve/main/diar_streaming_sortformer_4spk-v2.onnx', file: 'sortformer.onnx' }
    ]
  }
}

/**
 * Ensures a non-TDT model is downloaded and available.
 * @param {string} modelType - 'ctc', 'eou', or 'sortformer'
 * @returns {Promise<string|null>} Path to model directory, or null if type unknown
 */
async function ensureModelForType (modelType) {
  const cfg = MODEL_CONFIGS[modelType]
  if (!cfg) return null

  const { modelsDir } = getTestPaths()
  const targetPath = path.join(modelsDir, cfg.dirName)

  const allFilesExist = cfg.files.every(f =>
    fs.existsSync(path.join(targetPath, f.file))
  )

  if (allFilesExist) {
    console.log(`${modelType.toUpperCase()} model already downloaded`)
    return targetPath
  }

  console.log(`Downloading ${modelType.toUpperCase()} model from HuggingFace...`)
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true })
  }

  for (const { url, file } of cfg.files) {
    const destPath = path.join(targetPath, file)
    if (!fs.existsSync(destPath)) {
      console.log(`  Downloading ${file}...`)
      await downloadFile(url, destPath)
    }
  }

  console.log(`${modelType.toUpperCase()} model download complete`)
  return targetPath
}

/**
 * Build the named-paths config properties for a given model type.
 * C++ loads directly from these paths (no JS buffer loading needed).
 * @param {string} modelType - 'tdt', 'ctc', 'eou', or 'sortformer'
 * @param {string} modelDir - absolute path to the model directory
 * @returns {Object} named path config properties to spread into ParakeetInterface config
 */
function getNamedPathsConfig (modelType, modelDir) {
  switch (modelType) {
    case 'ctc':
      return {
        ctcModelPath: path.join(modelDir, 'model.onnx'),
        ctcModelDataPath: path.join(modelDir, 'model.onnx_data'),
        tokenizerPath: path.join(modelDir, 'tokenizer.json')
      }
    case 'eou':
      return {
        eouEncoderPath: path.join(modelDir, 'encoder.onnx'),
        eouDecoderPath: path.join(modelDir, 'decoder_joint.onnx'),
        tokenizerPath: path.join(modelDir, 'tokenizer.json')
      }
    case 'sortformer':
      return {
        sortformerPath: path.join(modelDir, 'sortformer.onnx')
      }
    case 'tdt':
    default:
      return {
        encoderPath: path.join(modelDir, 'encoder-model.onnx'),
        encoderDataPath: path.join(modelDir, 'encoder-model.onnx.data'),
        decoderPath: path.join(modelDir, 'decoder_joint-model.onnx'),
        vocabPath: path.join(modelDir, 'vocab.txt'),
        preprocessorPath: path.join(modelDir, 'preprocessor.onnx')
      }
  }
}

module.exports = {
  detectPlatform,
  waitUntilIdle,
  runTranscription,
  createAudioStream,
  calculateAudioDuration,
  generateTestAudio,
  makePcmNoise,
  setupJsLogger,
  getTestPaths,
  wordErrorRate,
  validateAccuracy,
  ensureModel,
  ensureModelForType,
  readFileChunked,
  getNamedPathsConfig,
  isMobile,
  platform,
  arch,
  MODEL_CONFIGS
}
