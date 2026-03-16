'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

const LOG_PRIORITIES = ['ERROR', 'WARNING', 'INFO', 'DEBUG']

// Grace period (ms) after JobEnded fires to wait for a late Output event.
// Increase on slow devices where inference may lag behind the event loop.
const JOB_TRACKER_GRACE_MS = 5000

/**
 * TDT model files to load (order matters)
 */
const TDT_MODEL_FILES = [
  'encoder-model.onnx',
  'decoder_joint-model.onnx',
  'preprocessor.onnx',
  'vocab.txt'
]

/**
 * CTC model files to load
 */
const CTC_MODEL_FILES = [
  'model.onnx',
  'model.onnx_data',
  'tokenizer.json'
]

/**
 * EOU model files to load
 */
const EOU_MODEL_FILES = [
  'encoder.onnx',
  'decoder_joint.onnx',
  'tokenizer.json'
]

/**
 * Sortformer model files to load
 */
const SORTFORMER_MODEL_FILES = [
  'sortformer.onnx'
]

/**
 * Setup C++ logger with formatted output
 * @param {Object} binding - The native binding
 */
function setupLogger (binding) {
  const shouldEnableNativeLogs = process.env &&
    process.env.QVAC_EXAMPLE_NATIVE_LOGS === '1'

  if (!shouldEnableNativeLogs) {
    if (!binding.__qvacExampleReleaseLoggerPatched) {
      binding.releaseLogger = () => {}
      binding.__qvacExampleReleaseLoggerPatched = true
    }
    return
  }

  if (binding.__qvacExampleLoggerSet) return
  binding.setLogger((priority, message) => {
    const priorityName = LOG_PRIORITIES[priority] || `UNKNOWN(${priority})`
    console.log(`[C++ ${priorityName}] ${message}`)
  })
  binding.__qvacExampleLoggerSet = true
}

/**
 * Read a file using streams to handle large files (>2GB)
 * @param {string} filePath - path to the file
 * @returns {Promise<Buffer>} - file contents as a Buffer
 */
function readFileAsStream (filePath) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', (err) => reject(err))
  })
}

/**
 * Parse WAV file and extract raw PCM data as Float32Array
 * @param {string} wavPath - path to the WAV file
 * @returns {Float32Array} - audio samples normalized to [-1, 1]
 */
function parseWavFile (wavPath) {
  const buffer = fs.readFileSync(wavPath)

  if (buffer.toString('utf8', 0, 4) !== 'RIFF') throw new Error('Not a valid WAV file')
  if (buffer.toString('utf8', 8, 12) !== 'WAVE') throw new Error('Not a valid WAV file')

  let pos = 12
  while (pos < buffer.length - 8) {
    const chunkId = buffer.toString('utf8', pos, pos + 4)
    const chunkSize = buffer.readUInt32LE(pos + 4)

    if (chunkId === 'data') {
      const dataStart = pos + 8
      const dataBuffer = buffer.slice(dataStart, dataStart + chunkSize)
      const samples = new Float32Array(dataBuffer.length / 2)
      for (let i = 0; i < samples.length; i++) {
        samples[i] = dataBuffer.readInt16LE(i * 2) / 32768
      }
      return samples
    }
    pos += 8 + chunkSize + (chunkSize % 2)
  }
  throw new Error('No data chunk found in WAV file')
}

/**
 * Convert raw PCM (16-bit signed integer) to Float32Array
 * @param {Buffer} rawBuffer - raw PCM buffer
 * @returns {Float32Array} - audio samples normalized to [-1, 1]
 */
function convertRawToFloat32 (rawBuffer) {
  const int16View = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audioData = new Float32Array(int16View.length)
  for (let i = 0; i < int16View.length; i++) {
    audioData[i] = int16View[i] / 32768.0
  }
  return audioData
}

/**
 * Load model weights from a directory
 * @param {Object} parakeet - ParakeetInterface instance
 * @param {string} modelPath - path to model directory
 * @param {string[]} [files] - model files to load (defaults to TDT_MODEL_FILES)
 */
async function loadModelWeights (parakeet, modelPath, files = TDT_MODEL_FILES) {
  for (const filename of files) {
    const filePath = path.join(modelPath, filename)
    if (!fs.existsSync(filePath)) {
      console.log(`   Skipping: ${filename} (not found)`)
      continue
    }

    const buffer = await readFileAsStream(filePath)
    const chunk = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)

    await parakeet.loadWeights({ filename, chunk, completed: true })
    console.log(`   Loaded: ${filename} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`)
  }
}

/**
 * Validate that required paths exist
 * @param {Object} paths - { model: string, audio: string }
 * @returns {boolean} - true if all paths exist
 */
function validatePaths (paths) {
  if (!fs.existsSync(paths.model)) {
    console.error(`Model not found: ${paths.model}`)
    console.error("Run 'npm run download-models' to download a model.")
    return false
  }
  if (paths.audio && !fs.existsSync(paths.audio)) {
    console.error(`Audio not found: ${paths.audio}`)
    return false
  }
  return true
}

/**
 * Create a promise that resolves when job ends and output is received.
 *
 * Handles a race condition where the addon's JobEnded event can fire before
 * the Output event on fast models. The promise resolves when both conditions
 * are met, or after a grace period following whichever fires first.
 *
 * @returns {{ promise: Promise, resolve: Function, transcriptions: Array }}
 */
function createJobTracker () {
  const transcriptions = []
  let resolveJob = null
  let hasOutput = false
  let jobEnded = false
  let graceTimeout = null

  const promise = new Promise(resolve => { resolveJob = resolve })

  const tryResolve = () => {
    if (hasOutput && jobEnded) {
      if (graceTimeout) clearTimeout(graceTimeout)
      resolveJob()
    }
  }

  return {
    promise,
    resolve: () => resolveJob(),
    transcriptions,
    markOutput () {
      hasOutput = true
      tryResolve()
    },
    markJobEnded () {
      jobEnded = true
      tryResolve()
      if (!hasOutput) {
        graceTimeout = setTimeout(() => resolveJob(), JOB_TRACKER_GRACE_MS)
      }
    }
  }
}

/**
 * Create a standard output callback that collects transcriptions
 * @param {Object} tracker - from createJobTracker()
 * @param {Object} [options] - { verbose: boolean }
 * @returns {Function} - output callback
 */
function createOutputCallback (tracker, options = {}) {
  return (handle, event, id, output, error) => {
    if (error) {
      console.error('Error:', error)
      return
    }

    if (event === 'Output' && output) {
      const segments = Array.isArray(output) ? output : [output]
      for (const seg of segments) {
        if (seg && seg.text && seg.toAppend) {
          tracker.transcriptions.push(seg)
          if (options.verbose) {
            console.log(`   [${seg.start?.toFixed(2) || '?'}s - ${seg.end?.toFixed(2) || '?'}s] ${seg.text}`)
          }
        }
      }
      tracker.markOutput()
    }

    if (event === 'JobEnded') {
      tracker.markJobEnded()
    }
  }
}

/**
 * Print transcription results
 * @param {Array} transcriptions - array of transcription segments
 */
function printResults (transcriptions) {
  console.log('\n=== RESULT ===')
  console.log('='.repeat(50))
  if (transcriptions.length > 0) {
    const text = transcriptions.map(s => s.text).join(' ').trim().replace(/\s+/g, ' ')
    console.log(text)
  } else {
    console.log('[No speech detected]')
  }
  console.log('='.repeat(50))
}

module.exports = {
  LOG_PRIORITIES,
  TDT_MODEL_FILES,
  CTC_MODEL_FILES,
  EOU_MODEL_FILES,
  SORTFORMER_MODEL_FILES,
  setupLogger,
  readFileAsStream,
  parseWavFile,
  convertRawToFloat32,
  loadModelWeights,
  validatePaths,
  createJobTracker,
  createOutputCallback,
  printResults
}
