'use strict'

// Shared helpers for the (flag-driven) examples. They orchestrate
// audio decode + native logger filtering + a small pushable async
// iterable for live-mic streaming. The examples themselves drive
// transcription through the public `TranscriptionParakeet` class
// (`require('../index.js')`).

const fs = require('bare-fs')

// Mirror of qvac_lib_inference_addon_cpp::logger::Priority. The
// native binding queues every priority; we filter at WARNING+ here
// so kernel-JIT INFO spam from ggml's GPU backends never reaches the
// console. To see INFO/DEBUG, lower NATIVE_MIN_PRIORITY below.
const LOG_PRIORITIES = ['ERROR', 'WARNING', 'INFO', 'DEBUG']
const NATIVE_MIN_PRIORITY = 1 // WARNING

/**
 * Install a JS-side sink for native log messages. Filters at
 * WARNING+ so ggml's metal/vulkan/opencl kernel-JIT INFO lines stay
 * silent. Edit NATIVE_MIN_PRIORITY at the top of this file to see
 * INFO / DEBUG. Pass `require('../addonLogging.js')` (or the raw
 * binding) -- both expose `setLogger` / `releaseLogger`.
 *
 * @param {Object} loggerBinding
 */
function setupLogger (loggerBinding) {
  if (loggerBinding.__qvacExampleLoggerSet) return
  loggerBinding.setLogger((priority, message) => {
    if (priority > NATIVE_MIN_PRIORITY) return
    const name = LOG_PRIORITIES[priority] || `UNKNOWN(${priority})`
    console.log(`[C++ ${name}] ${message}`)
  })
  loggerBinding.__qvacExampleLoggerSet = true
}

/**
 * Read a file using streams to handle large GGUFs (>2 GiB).
 */
function readFileAsStream (filePath) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

/**
 * Parse a WAV file (RIFF/PCM int16 mono) into a Float32Array of
 * normalised samples. Skips non-`data` chunks.
 */
function parseWavFile (wavPath) {
  const buffer = fs.readFileSync(wavPath)
  if (buffer.toString('utf8', 0, 4) !== 'RIFF') throw new Error('Not a valid WAV file')
  if (buffer.toString('utf8', 8, 12) !== 'WAVE') throw new Error('Not a valid WAV file')

  let pos = 12
  while (pos < buffer.length - 8) {
    const id = buffer.toString('utf8', pos, pos + 4)
    const sz = buffer.readUInt32LE(pos + 4)
    if (id === 'data') {
      const data = buffer.slice(pos + 8, pos + 8 + sz)
      const samples = new Float32Array(data.length / 2)
      for (let i = 0; i < samples.length; i++) {
        samples[i] = data.readInt16LE(i * 2) / 32768
      }
      return samples
    }
    pos += 8 + sz + (sz % 2)
  }
  throw new Error('No data chunk found in WAV file')
}

/**
 * Convert a raw int16 little-endian PCM buffer to a normalised
 * Float32Array. Used for `.raw` audio fixtures.
 */
function convertRawToFloat32 (rawBuffer) {
  const view = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const out = new Float32Array(view.length)
  for (let i = 0; i < view.length; i++) out[i] = view[i] / 32768
  return out
}

/**
 * Validate that required paths exist on disk.
 */
function validatePaths (paths) {
  if (!fs.existsSync(paths.model)) {
    console.error(`Model not found: ${paths.model}`)
    console.error("Run 'npm run setup-models' or pass --model </path/to/model.gguf>.")
    return false
  }
  if (paths.audio && !fs.existsSync(paths.audio)) {
    console.error(`Audio not found: ${paths.audio}`)
    return false
  }
  return true
}

/**
 * Pushable async-iterable: consumers `await for (const chunk of
 * stream)` while producers `stream.push(chunk)` and `stream.end()`
 * close it. Used by the live-mic examples to feed chunks captured
 * from `sox` into `TranscriptionParakeet.runStreaming()` (duplex
 * path) without buffering the entire stream. Also accepted by the
 * batched `run()` path; both consumers iterate it lazily.
 */
function pushableStream () {
  const queue = []
  let waiter = null
  let ended = false

  function push (chunk) {
    if (ended) return
    queue.push(chunk)
    if (waiter) {
      const w = waiter
      waiter = null
      w()
    }
  }

  function end () {
    ended = true
    if (waiter) {
      const w = waiter
      waiter = null
      w()
    }
  }

  return {
    push,
    end,
    async * [Symbol.asyncIterator] () {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()
          continue
        }
        if (ended) return
        await new Promise(resolve => { waiter = resolve })
      }
    }
  }
}

/**
 * Print transcription segments to stdout in a uniform banner block.
 */
function printResults (segments) {
  console.log('\n=== RESULT ===')
  console.log('='.repeat(50))
  if (segments.length > 0) {
    const text = segments.map(s => s.text).join(' ').trim().replace(/\s+/g, ' ')
    console.log(text)
  } else {
    console.log('[No speech detected]')
  }
  console.log('='.repeat(50))
}

module.exports = {
  setupLogger,
  readFileAsStream,
  parseWavFile,
  convertRawToFloat32,
  validatePaths,
  pushableStream,
  printResults
}
