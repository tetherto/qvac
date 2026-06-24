'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const { spawn, spawnSync } = require('bare-subprocess')
const TranscriptionWhispercpp = require('../index.js')

const SAMPLE_RATE = 16000
const DEFAULT_DURATION_SECONDS = 30

/**
 * Example: Microphone conversation streaming
 *
 * Captures microphone audio with ffmpeg, streams it into runStreaming(), and
 * prints VAD state updates, end-of-turn events, and transcript segments.
 *
 * Usage:
 *   bare examples/example.mic-conversation.js [durationSeconds] [modelPath] [vadModelPath]
 *
 * Use durationSeconds=0 to run until Ctrl+C.
 */

function getAudioInputArgs () {
  switch (os.platform()) {
    case 'darwin':
      return ['-f', 'avfoundation', '-i', ':0']
    case 'linux':
      return ['-f', 'pulse', '-i', 'default']
    default:
      throw new Error(`Unsupported microphone platform: ${os.platform()}`)
  }
}

function ensureFfmpeg () {
  const result = spawnSync('ffmpeg', ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] })
  if (result.status !== 0) {
    throw new Error('ffmpeg is required for microphone capture')
  }
}

function startMicStream () {
  return spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    ...getAudioInputArgs(),
    '-ar', String(SAMPLE_RATE),
    '-ac', '1',
    '-sample_fmt', 's16',
    '-f', 's16le',
    'pipe:1'
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function parseArgs () {
  const args = process.argv.slice(2)
  const modelsDir = path.join(__dirname, '..', 'models')
  const durationSeconds = Number.parseInt(args[0] || String(DEFAULT_DURATION_SECONDS), 10)

  return {
    durationSeconds: Number.isNaN(durationSeconds) ? DEFAULT_DURATION_SECONDS : durationSeconds,
    modelPath: args[1] || path.join(modelsDir, 'ggml-tiny.bin'),
    vadModelPath: args[2] || path.join(modelsDir, 'ggml-silero-v5.1.2.bin')
  }
}

function assertFileExists (filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`)
  }
}

async function main () {
  ensureFfmpeg()

  const { durationSeconds, modelPath, vadModelPath } = parseArgs()
  assertFileExists(modelPath, 'Model file')
  assertFileExists(vadModelPath, 'VAD model')

  console.log('=== Microphone Conversation Streaming Example ===\n')
  console.log(`Model:     ${modelPath}`)
  console.log(`VAD Model: ${vadModelPath}`)
  console.log(`Duration:  ${durationSeconds === 0 ? 'until Ctrl+C' : `${durationSeconds}s`}`)
  console.log('\nSpeak, then pause to see end-of-turn events.\n')

  const model = new TranscriptionWhispercpp(
    {
      files: {
        model: modelPath,
        vadModel: vadModelPath
      }
    },
    {
      whisperConfig: {
        language: 'en',
        audio_format: 's16le',
        temperature: 0.0,
        suppress_nst: true,
        vad_params: {
          threshold: 0.5,
          min_silence_duration_ms: 300,
          min_speech_duration_ms: 250,
          max_speech_duration_s: 30,
          speech_pad_ms: 30,
          samples_overlap: 0.1
        }
      },
      vadModelPath
    }
  )

  await model._load()

  const ffmpeg = startMicStream()
  let response
  let timeout = null

  ffmpeg.stderr.on('data', data => {
    const message = data.toString().trim()
    if (message) console.error(`[ffmpeg] ${message}`)
  })

  const stop = async () => {
    if (timeout) clearTimeout(timeout)
    try {
      ffmpeg.kill('SIGTERM')
    } catch {}
  }

  process.on('SIGINT', () => {
    console.log('\nStopping microphone stream...')
    stop().catch(() => {})
  })

  try {
    response = await model.runStreaming(ffmpeg.stdout, {
      emitVadEvents: true,
      endOfTurnSilenceMs: 750,
      vadRunIntervalMs: 300
    })

    response.onUpdate(data => {
      if (data?.type === 'vad') {
        console.log(`[vad] speaking=${data.speaking} probability=${data.probability}`)
        return
      }
      if (data?.type === 'endOfTurn') {
        console.log(`[endOfTurn] silence=${data.silenceDurationMs}ms`)
        return
      }

      const items = Array.isArray(data) ? data : [data]
      for (const item of items) {
        const text = (item.text || '').trim()
        if (text) console.log(`[transcript] ${text}`)
      }
    })

    if (durationSeconds > 0) {
      timeout = setTimeout(() => {
        stop().catch(() => {})
      }, durationSeconds * 1000)
    }

    await response.await()
  } finally {
    if (timeout) clearTimeout(timeout)
    await model.destroy()
  }

  console.log('\nMicrophone conversation example complete.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
