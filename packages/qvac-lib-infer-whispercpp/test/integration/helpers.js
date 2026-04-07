'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const { Readable } = require('bare-stream')
const TranscriptionWhispercpp = require('../../index.js')

const platform = os.platform()
const arch = os.arch()
const isMobile = platform === 'ios' || platform === 'android'

const HF_WHISPER_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
const HF_VAD_BASE = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main'

function detectPlatform () {
  return `${platform}-${arch}`
}

async function downloadWithHttp (url, destPath, maxRedirects = 10) {
  const https = require('bare-https')
  const { URL } = require('bare-url')

  const parsedUrl = new URL(url)

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || 443,
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; bare-download/1.0)'
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        if (maxRedirects <= 0) {
          reject(new Error('Too many redirects'))
          return
        }
        const location = res.headers.location
        let redirectUrl
        if (location.startsWith('http://') || location.startsWith('https://')) {
          redirectUrl = location
        } else if (location.startsWith('/')) {
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${location}`
        } else {
          const basePath = parsedUrl.pathname.substring(0, parsedUrl.pathname.lastIndexOf('/') + 1)
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${basePath}${location}`
        }
        downloadWithHttp(redirectUrl, destPath, maxRedirects - 1)
          .then(resolve)
          .catch(reject)
        return
      }

      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`))
        return
      }

      const dir = path.dirname(destPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      const file = fs.createWriteStream(destPath)
      const contentLength = parseInt(res.headers['content-length'] || '0', 10)

      file.on('error', (err) => {
        res.destroy()
        reject(err)
      })

      res.on('error', (err) => {
        file.destroy()
        reject(err)
      })

      res.pipe(file)

      file.on('close', () => {
        if (contentLength > 0) {
          console.log(`  Downloaded ${(contentLength / 1024 / 1024).toFixed(1)}MB`)
        }
        resolve()
      })
    })

    req.on('error', reject)
    req.end()
  })
}

async function downloadFile (url, destPath) {
  return downloadWithHttp(url, destPath)
}

async function ensureWhisperModel (modelPath) {
  const modelName = path.basename(modelPath)
  const diskPath = path.dirname(modelPath)

  if (!fs.existsSync(diskPath)) {
    fs.mkdirSync(diskPath, { recursive: true })
  }

  if (fs.existsSync(modelPath)) {
    const stats = fs.statSync(modelPath)
    if (stats.size > 1000000) {
      console.log(`Using cached model: ${modelName} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`)
      return { success: true, path: modelPath, isReal: true }
    }
  }

  const url = `${HF_WHISPER_BASE}/${modelName}`
  console.log(`Downloading ${modelName} from HuggingFace...`)

  try {
    await downloadFile(url, modelPath)

    if (fs.existsSync(modelPath)) {
      const stats = fs.statSync(modelPath)
      if (stats.size > 1000000) {
        console.log(`Downloaded model: ${modelName} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`)
        return { success: true, path: modelPath, isReal: true }
      }
    }

    console.log(`Download produced invalid file for ${modelName}`)
    return { success: false, path: modelPath, isReal: false }
  } catch (err) {
    console.log(`Failed to download ${modelName}: ${err.message}`)
    return { success: false, path: modelPath, isReal: false, error: err.message }
  }
}

async function ensureVADModel (vadModelPath) {
  const modelName = path.basename(vadModelPath)
  const diskPath = path.dirname(vadModelPath)

  if (fs.existsSync(vadModelPath)) {
    const stats = fs.statSync(vadModelPath)
    if (stats.size > 500000) {
      console.log(`Using cached VAD model: ${modelName} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`)
      return true
    }
  }

  if (!fs.existsSync(diskPath)) {
    fs.mkdirSync(diskPath, { recursive: true })
  }

  const url = `${HF_VAD_BASE}/${modelName}`
  console.log(`Downloading ${modelName} from HuggingFace...`)

  try {
    await downloadFile(url, vadModelPath)

    if (fs.existsSync(vadModelPath)) {
      const stats = fs.statSync(vadModelPath)
      if (stats.size > 500000) {
        console.log(`Downloaded VAD model: ${modelName} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`)
        return true
      }
    }

    console.log(`Download produced invalid file for ${modelName}`)
    return false
  } catch (err) {
    console.log(`Failed to download ${modelName}: ${err.message}`)
    return false
  }
}

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
 * @param {string|Buffer|Uint8Array|Array|Readable} audioInput - Audio input in various formats
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
      const copy = new Uint8Array(chunk)
      chunks.push(copy)
    }
    return Readable.from(chunks)
  } else if (Buffer.isBuffer(audioInput) || audioInput instanceof Uint8Array) {
    // Buffer or Uint8Array - convert to stream
    return Readable.from([audioInput])
  } else if (Array.isArray(audioInput)) {
    // Array of chunks - convert to stream
    return Readable.from(audioInput)
  } else if (audioInput && typeof audioInput.read === 'function') {
    // Already a stream - return as-is
    return audioInput
  } else {
    throw new Error(`Unsupported audio input type: ${typeof audioInput}`)
  }
}

/**
 * Calculate audio duration in milliseconds from audio buffer
 * @param {Buffer|Uint8Array} audioBuffer - Audio data buffer
 * @param {string} audioFormat - Audio format ('s16le' or 'f32le')
 * @param {number} sampleRate - Sample rate in Hz (default: 16000)
 * @returns {number} Duration in milliseconds
 */
function calculateAudioDuration (audioBuffer, audioFormat = 's16le', sampleRate = 16000) {
  let bytesPerSample
  if (audioFormat === 's16le') {
    bytesPerSample = 2
  } else if (audioFormat === 'f32le') {
    bytesPerSample = 4
  } else {
    // Default to s16le if unknown
    bytesPerSample = 2
  }

  const numSamples = audioBuffer.length / bytesPerSample
  const durationSeconds = numSamples / sampleRate
  return durationSeconds * 1000
}

/**
 * Generates a test audio file with a sine wave tone
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
  const buffer = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const sample = Math.sin(2 * Math.PI * frequency * i / sampleRate) * amplitude
    buffer.writeInt16LE(Math.round(sample * 32767), i * 2)
  }
  fs.writeFileSync(filepath, buffer)
  return filepath
}

/**
 * Generates PCM noise for testing audio processing robustness
 * @param {number} numSamples - Number of audio samples to generate
 * @param {number} [amplitude=1000] - Maximum amplitude of noise
 * @returns {Uint8Array} PCM noise data as Uint8Array
 */
function makePcmNoise (numSamples, amplitude = 1000) {
  const buf = Buffer.alloc(numSamples * 2)
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.floor((Math.random() * 2 - 1) * amplitude)
    buf.writeInt16LE(sample, i * 2)
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/**
 * Sets up JavaScript logger for C++ bindings
 * @param {Object} [binding] - Optional binding instance (will require if not provided)
 * @returns {Object} The binding instance with logger configured
 */
function setupJsLogger (binding = null) {
  const actualBinding = binding || require('../../binding')
  const LOG_PRIORITIES = ['ERROR', 'WARNING', 'INFO', 'DEBUG']
  actualBinding.setLogger((priority, message) => {
    const priorityName = LOG_PRIORITIES[priority] || `UNKNOWN(${priority})`
    console.log(`[C++ ${priorityName}] ${message}`)
  })
  return actualBinding
}

/**
 * Calculate Word Error Rate (WER) between expected and actual transcriptions
 * Uses Levenshtein distance algorithm at word level
 * @param {string} expected - Expected/reference transcription
 * @param {string} actual - Actual/hypothesis transcription
 * @returns {number} WER as a decimal (0.0 = perfect, 1.0 = 100% error)
 */
function wordErrorRate (expected, actual) {
  // Normalize text: lowercase, collapse whitespace, trim
  const normalize = (text) => text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()

  const r = normalize(expected).split(/\s+/).filter(w => w.length > 0)
  const h = normalize(actual).split(/\s+/).filter(w => w.length > 0)

  if (r.length === 0) {
    return h.length === 0 ? 0 : 1
  }

  // Create distance matrix
  const d = Array(r.length + 1)
    .fill(null)
    .map(() => Array(h.length + 1).fill(0))

  // Initialize first column and row
  for (let i = 0; i <= r.length; i++) d[i][0] = i
  for (let j = 0; j <= h.length; j++) d[0][j] = j

  // Fill in the rest of the matrix
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      const cost = r[i - 1] === h[j - 1] ? 0 : 1
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost // substitution
      )
    }
  }

  const wer = d[r.length][h.length] / r.length
  return wer
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
 * Get path to a test asset file - works on both desktop and mobile
 * On mobile, asset files must be in test/mobile/testAssets/
 * On desktop, asset files are in examples/samples/ or test/mobile/testAssets/
 *
 * @param {string} filename - Name of the asset file (e.g., 'sample.raw')
 * @param {object} options - Options
 * @param {string} options.desktopDir - Directory to look in on desktop (default: 'examples/samples')
 * @returns {string} - Full path to the asset file
 */
function getAssetPath (filename, options = {}) {
  const { desktopDir = 'examples/samples' } = options

  // Mobile environment - use asset loading from testAssets
  if (isMobile && global.assetPaths) {
    const projectPath = `../../testAssets/${filename}`

    if (global.assetPaths[projectPath]) {
      const resolvedPath = global.assetPaths[projectPath].replace('file://', '')
      return resolvedPath
    }
    // Asset not found in manifest
    throw new Error(`Asset not found in testAssets: ${filename}. Make sure ${filename} is in test/mobile/testAssets/ directory and rebuild the app.`)
  }

  // Desktop environment - check multiple locations
  const possiblePaths = [
    // First check testAssets (for test-specific files)
    path.resolve(__dirname, '../mobile/testAssets', filename),
    // Then check examples/samples directory
    path.resolve(__dirname, `../../${desktopDir}`, filename)
  ]

  for (const testPath of possiblePaths) {
    if (fs.existsSync(testPath)) {
      return testPath
    }
  }

  // Return the first path (will fail with appropriate error message)
  return possiblePaths[0]
}

/**
 * Gets standard test paths for models and audio files
 * Handles mobile vs desktop paths automatically
 * @param {string} [modelsDir] - Optional models directory (defaults to '../../models')
 * @returns {Object} Object with modelsDir, samplesDir, modelPath, vadModelPath, and audioPath
 */
function getTestPaths (modelsDir = null) {
  // On mobile, use global.testDir if available (set by mobile test framework)
  const writableRoot = global.testDir || (isMobile ? os.tmpdir() : null)

  let actualModelsDir, samplesDir

  if (isMobile && writableRoot) {
    // Mobile: use writable directory
    actualModelsDir = modelsDir || path.join(writableRoot, 'models')
    samplesDir = path.join(writableRoot, 'samples')
  } else {
    // Desktop: use package-root models/ and examples/samples/
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
    testDir: actualModelsDir, // kept for backward compatibility
    modelsDir: actualModelsDir,
    samplesDir,
    modelPath: path.join(actualModelsDir, 'ggml-tiny.bin'),
    vadModelPath: path.join(actualModelsDir, 'ggml-silero-v5.1.2.bin'),
    audioPath: path.join(samplesDir, 'integration-test-sample.raw'),
    isMobile
  }
}

/**
 * Run transcription using TranscriptionWhispercpp
 * @param {Object} params - Transcription parameters
 * @param {string|Buffer|Uint8Array|Array|Readable} [params.audioInput] - Audio input (optional - if omitted, only tests config validation)
 * @param {string} [params.modelPath] - Path to whisper model file
 * @param {string} [params.vadModelPath] - Path to VAD model file
 * @param {Object} [params.whisperConfig] - Whisper configuration object
 * @param {Object} [expectation={}] - Expectations for validation
 * @param {number} [expectation.minSegments] - Minimum number of segments
 * @param {number} [expectation.maxSegments] - Maximum number of segments
 * @param {number} [expectation.minTextLength] - Minimum text length
 * @param {number} [expectation.maxTextLength] - Maximum text length
 * @param {string} [expectation.expectedText] - Substring that should appear
 * @param {number} [expectation.minDurationMs] - Minimum duration in ms
 * @param {number} [expectation.maxDurationMs] - Maximum duration in ms
 * @param {string[]} [expectation.shouldContain] - Array of strings that must appear
 * @param {string[]} [expectation.shouldNotContain] - Array of strings that must not appear
 * @param {Function} [params.onUpdate] - Optional callback for real-time updates: (outputArr) => void
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

  const defaultModelsDir = path.resolve(__dirname, '../../models')
  const defaultModelPath = path.join(defaultModelsDir, 'ggml-tiny.bin')

  const modelPath = params.modelPath || defaultModelPath
  const vadModelPath = params.vadModelPath // VAD model is optional, no default

  const whisperConfig = params.whisperConfig || {}

  const config = {
    path: modelPath,
    vadModelPath,
    whisperConfig: {
      language: whisperConfig.language || 'en',
      audio_format: whisperConfig.audio_format || 's16le',
      temperature: whisperConfig.temperature ?? 0.0,
      suppress_nst: whisperConfig.suppress_nst ?? true,
      n_threads: whisperConfig.n_threads || 0,
      vad_params: whisperConfig.vadParams || whisperConfig.vad_params,
      ...whisperConfig
    }
  }

  const constructorArgs = {
    files: {
      model: modelPath,
      ...(vadModelPath ? { vadModel: vadModelPath } : {})
    }
  }

  if (typeof modelPath === 'string' && !fs.existsSync(modelPath)) {
    return {
      output: `Error: Model file not found: ${modelPath}`,
      passed: false,
      data: { error: `Model file not found: ${modelPath}` }
    }
  }

  let model
  try {
    model = new TranscriptionWhispercpp(constructorArgs, config)
    await model._load()

    // If no audioInput provided, just test config validation (model loading)
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

    let fileSize = 0
    if (typeof params.audioInput === 'string') {
      try {
        const stats = fs.statSync(params.audioInput)
        fileSize = stats.size
      } catch (e) {
        // Ignore if file can't be read
      }
    } else if (Buffer.isBuffer(params.audioInput) || params.audioInput instanceof Uint8Array) {
      fileSize = params.audioInput.length
    } else if (Array.isArray(params.audioInput) && params.audioInput.length > 0) {
      fileSize = params.audioInput.reduce((sum, chunk) => sum + chunk.length, 0)
    }

    const response = await model.run(audioStream)

    const segments = []
    let jobStats = null

    await response
      .onUpdate((outputArr) => {
        const items = Array.isArray(outputArr) ? outputArr : [outputArr]
        segments.push(...items)
        // Call custom onUpdate callback if provided
        if (params.onUpdate) {
          params.onUpdate(outputArr)
        }
      })
      .await()

    if (response.stats) {
      jobStats = response.stats
    }

    const audioFormat = config.whisperConfig.audio_format || 's16le'
    let durationMs = 0
    if (fileSize > 0) {
      // Calculate duration from file size: fileSize / bytesPerSample / sampleRate
      let bytesPerSample
      if (audioFormat === 's16le') {
        bytesPerSample = 2
      } else if (audioFormat === 'f32le') {
        bytesPerSample = 4
      } else {
        bytesPerSample = 2
      }
      const WHISPER_SAMPLE_RATE = 16000
      const numSamples = fileSize / bytesPerSample
      const durationSeconds = numSamples / WHISPER_SAMPLE_RATE
      durationMs = durationSeconds * 1000
    } else if (segments.length > 0) {
      // Fallback: Calculate from segments if available
      const lastSegment = segments[segments.length - 1]
      if (lastSegment && typeof lastSegment.end === 'number') {
        durationMs = lastSegment.end * 1000 // Convert seconds to ms
      }
    }

    const fullText = segments
      .map(s => (s && s.text) ? s.text : '')
      .filter(t => t.trim().length > 0)
      .join(' ')
      .trim()
      .replace(/\s+/g, ' ')

    const textLength = fullText.length
    const segmentCount = segments.length

    // Validate expectations
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
    if (expectation.maxTextLength !== undefined && textLength > expectation.maxTextLength) {
      passed = false
    }
    if (expectation.expectedText !== undefined && !fullText.includes(expectation.expectedText)) {
      passed = false
    }
    if (expectation.minDurationMs !== undefined && durationMs < expectation.minDurationMs) {
      passed = false
    }
    if (expectation.maxDurationMs !== undefined && durationMs > expectation.maxDurationMs) {
      passed = false
    }
    if (expectation.shouldContain && Array.isArray(expectation.shouldContain)) {
      for (const text of expectation.shouldContain) {
        if (!fullText.includes(text)) {
          passed = false
          break
        }
      }
    }
    if (expectation.shouldNotContain && Array.isArray(expectation.shouldNotContain)) {
      for (const text of expectation.shouldNotContain) {
        if (fullText.includes(text)) {
          passed = false
          break
        }
      }
    }

    // Round stats for readability
    const roundedStats = jobStats
      ? {
          totalTime: jobStats.totalTime ? Number(jobStats.totalTime.toFixed(4)) : jobStats.totalTime,
          tokensPerSecond: jobStats.tokensPerSecond ? Number(jobStats.tokensPerSecond.toFixed(2)) : jobStats.tokensPerSecond,
          realTimeFactor: jobStats.realTimeFactor ? Number(jobStats.realTimeFactor.toFixed(5)) : jobStats.realTimeFactor,
          audioDurationMs: jobStats.audioDurationMs,
          totalSamples: jobStats.totalSamples
        }
      : null

    // Build output message
    const statsInfo = jobStats
      ? `duration: ${durationMs.toFixed(0)}ms, RTF: ${jobStats.realTimeFactor?.toFixed(4) || 'N/A'}`
      : `duration: ${durationMs.toFixed(0)}ms (calculated)`

    const audioInputPreview = typeof params.audioInput === 'string'
      ? path.basename(params.audioInput)
      : (Buffer.isBuffer(params.audioInput) || params.audioInput instanceof Uint8Array
          ? `${(params.audioInput.length / 1024).toFixed(1)}KB`
          : 'stream')

    const output = `Transcribed ${segmentCount} segments (${statsInfo}) from audio: "${audioInputPreview}"`

    return {
      output,
      passed,
      data: {
        segments,
        segmentCount,
        fullText,
        textLength,
        durationMs,
        stats: roundedStats
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
        durationMs: 0,
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

module.exports = {
  detectPlatform,
  ensureWhisperModel,
  ensureVADModel,
  waitUntilIdle,
  runTranscription,
  createAudioStream,
  calculateAudioDuration,
  generateTestAudio,
  makePcmNoise,
  setupJsLogger,
  getTestPaths,
  getAssetPath,
  wordErrorRate,
  validateAccuracy,
  isMobile,
  platform,
  arch
}
