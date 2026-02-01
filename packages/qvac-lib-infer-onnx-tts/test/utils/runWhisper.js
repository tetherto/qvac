const TranscriptionWhispercpp = require('@qvac/transcription-whispercpp')
const { Readable } = require('bare-stream')
const path = require('bare-path')
const os = require('bare-os')
const FakeDL = require('./loader.fake')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

// Returns base directory for models - uses global.testDir on mobile, current dir otherwise
function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

async function loadWhisper (params = {}) {
  const defaultPath = path.join(getBaseDir(), 'models', 'whisper')
  const modelName = params.modelName || 'ggml-tiny.bin'
  const diskPath = params.diskPath || defaultPath
  console.log('>>> [WHISPER] Loading model from:', diskPath)

  // Instantiate Hyperdrive Loader with the specific model key
  const hdDL = new FakeDL({})

  const constructorArgs = {
    loader: hdDL,
    modelName,
    diskPath
  }
  const config = {
    opts: { stats: true },
    whisperConfig: {
      audio_format: 's16le',
      language: params.language || 'en',
      temperature: 0.0
    }
  }

  const whisperModel = new TranscriptionWhispercpp(constructorArgs, config)
  await whisperModel._load()
  console.log('>>> [WHISPER] Model loaded')

  return whisperModel
}

async function runWhisper (model, text, wavBuffer) {
  // Create a readable stream from the WAV buffer
  const audioStream = Readable.from([Buffer.from(wavBuffer)])
  const response = await model.run(audioStream)
  let fullText = ''
  let retryCount = 0

  while (retryCount < 3) {
    try {
      fullText = await _processResponse(response)
      if (fullText.length > 0) {
        break
      }
    } catch (error) {
      console.error('>>> [WHISPER] Error:', error)
      retryCount++
    }
  }
  console.log(`>>> [WHISPER] Full text: ${fullText}`)
  const wer = wordErrorRate(text, fullText)
  return { wer }
}

async function _processResponse (response) {
  let fullText = ''
  await response.onUpdate((output) => {
    if (Array.isArray(output)) {
      for (const item of output) {
        if (item.text) {
          fullText += item.text
        }
      }
    }
  }).await()
  return fullText
}

function wordErrorRate (expected, actual) {
  // Normalize text for comparison
  const normalize = (text) => {
    return text
      .trim()
      .toLowerCase()
    // Remove punctuation (periods, commas, exclamation, question marks, etc.)
      .replace(/[.,!?;:"""''„«»()[\]{}]/g, '')
    // Normalize apostrophes (handle French contractions like l'aube -> l aube)
      .replace(/[''ʼ]/g, ' ')
    // Normalize hyphens (au-dessus -> au dessus)
      .replace(/[-–—]/g, ' ')
    // Collapse multiple spaces into one
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\s+/)
  }

  const r = normalize(expected)
  const h = normalize(actual)
  const d = Array(r.length + 1)
    .fill(null)
    .map(() => Array(h.length + 1).fill(0))

  for (let i = 0; i <= r.length; i++) d[i][0] = i
  for (let j = 0; j <= h.length; j++) d[0][j] = j

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

  const wer = Math.round((d[r.length][h.length] / r.length) * 10) / 10
  return wer
}

module.exports = { loadWhisper, runWhisper }
