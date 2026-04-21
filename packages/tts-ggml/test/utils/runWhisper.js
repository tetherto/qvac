const TranscriptionWhispercpp = require('@qvac/transcription-whispercpp')
const { Readable } = require('bare-stream')
const path = require('bare-path')
const os = require('bare-os')
const FakeDL = require('./loader.fake')

const WHISPER_SAMPLE_RATE = 16000

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

async function loadWhisper (params = {}) {
  const defaultPath = path.join(getBaseDir(), 'models', 'whisper')
  const modelName = params.modelName || 'ggml-tiny.bin'
  const diskPath = params.diskPath || defaultPath
  console.log('>>> [WHISPER] Loading model from:', diskPath)

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
      translate: false,
      temperature: 0.0
    }
  }

  const whisperModel = new TranscriptionWhispercpp(constructorArgs, config)
  await whisperModel._load()
  console.log('>>> [WHISPER] Model loaded')

  return whisperModel
}

function extractWavPcm (wavBuf) {
  if (wavBuf.length < 44) return { raw: wavBuf, sampleRate: WHISPER_SAMPLE_RATE }
  const isRiff = wavBuf[0] === 0x52 && wavBuf[1] === 0x49 &&
    wavBuf[2] === 0x46 && wavBuf[3] === 0x46
  if (!isRiff) return { raw: wavBuf, sampleRate: WHISPER_SAMPLE_RATE }

  const sampleRate = wavBuf[24] | (wavBuf[25] << 8) |
    (wavBuf[26] << 16) | (wavBuf[27] << 24)

  let dataOffset = 12
  while (dataOffset + 8 <= wavBuf.length) {
    const id = String.fromCharCode(
      wavBuf[dataOffset], wavBuf[dataOffset + 1],
      wavBuf[dataOffset + 2], wavBuf[dataOffset + 3]
    )
    const chunkSize = wavBuf[dataOffset + 4] | (wavBuf[dataOffset + 5] << 8) |
      (wavBuf[dataOffset + 6] << 16) | (wavBuf[dataOffset + 7] << 24)
    if (id === 'data') {
      const start = dataOffset + 8
      const end = Math.min(start + chunkSize, wavBuf.length)
      return { raw: wavBuf.slice(start, end), sampleRate }
    }
    dataOffset += 8 + chunkSize
    if (chunkSize % 2 === 1 && dataOffset < wavBuf.length) dataOffset += 1
  }

  return { raw: wavBuf.slice(44), sampleRate }
}

function resampleS16le (pcmBuf, fromRate, toRate) {
  if (fromRate === toRate) return pcmBuf

  const numSamples = Math.floor(pcmBuf.length / 2)
  const ratio = fromRate / toRate
  const outLen = Math.round(numSamples / ratio)
  const out = Buffer.alloc(outLen * 2)

  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio
    const lo = Math.floor(srcIdx)
    const hi = Math.min(lo + 1, numSamples - 1)
    const frac = srcIdx - lo
    const sLo = pcmBuf.readInt16LE(lo * 2)
    const sHi = pcmBuf.readInt16LE(hi * 2)
    const val = Math.round(sLo * (1 - frac) + sHi * frac)
    out.writeInt16LE(Math.max(-32768, Math.min(32767, val)), i * 2)
  }

  return out
}

async function runWhisper (model, text, wavBuffer) {
  const buf = Buffer.from(wavBuffer)
  const { raw, sampleRate } = extractWavPcm(buf)
  const pcm16k = resampleS16le(Buffer.from(raw), sampleRate, WHISPER_SAMPLE_RATE)

  console.log(`>>> [WHISPER] Audio: ${sampleRate}Hz -> ${WHISPER_SAMPLE_RATE}Hz, ${pcm16k.length / 2} samples`)

  const audioStream = Readable.from([pcm16k])
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
