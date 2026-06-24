'use strict'

/**
 * Live-mic transcription example (duplex streaming).
 *
 * Captures the default input device via `sox -d` (16 kHz mono s16le)
 * and feeds every chunk straight into the model's duplex streaming
 * session through `model.runStreaming(stream)`. Per-chunk transcripts
 * surface via `response.onUpdate(...)` as soon as the engine emits
 * them. Press Ctrl-C to flush and exit.
 *
 * Internally `runStreaming()` opens a long-lived
 * `parakeet::StreamSession` (or `SortformerStreamSession`) on the C++
 * side and forwards each chunk via `appendStreamingAudio()` -- no
 * batching, no per-chunk session recreation, no `runJob` plumbing.
 *
 * Usage:
 *   bare examples/live-mic.js --model <gguf> [--accumulate] \
 *                             [--chunk-ms <ms>] [--capture "<sox cmd>"]
 *
 * The default capture command (`sox -d -t raw ... -`) works on macOS / Linux
 * and on Windows builds where sox auto-selects a working driver. If sox exits
 * immediately on Windows, override the capture pipeline explicitly, e.g.
 *   --capture "sox -t waveaudio default -t raw -r 16000 -b 16 -c 1 -e signed-integer -L -"
 */

/* global Bare */
const path = require('bare-path')
const process = require('bare-process')
const subprocess = require('bare-subprocess')
const TranscriptionParakeet = require('../index.js')
const addonLogging = require('../addonLogging.js')
const { setupLogger, validatePaths, pushableStream } = require('./utils.js')

const CAPTURE_CMD = 'sox -d -t raw -r 16000 -b 16 -c 1 -e signed-integer -L -'

const SILENCE_SENTINELS = new Set([
  '[No speech detected]',
  '[Audio too short]',
  '[Model not ready]'
])

function isSilenceText (text) {
  return text.length === 0 || SILENCE_SENTINELS.has(text)
}

// Streaming TDT/CTC sometimes emits a single word as two segments
// straddling a chunk boundary, e.g. "punctuation" -> ["pun",
// "ctuation"], "Well" -> ["W", "ell"]. parakeet-cpp surfaces a
// per-segment `startsWord` flag (set false on wordpiece continuations
// of the previous segment, true on fresh SentencePiece word starts);
// we use it to gate the inserted separator so "see" + "if" stays
// "see if" but "pun" + "ctuation" rejoins into "punctuation".
// Returns { text, firstStartsWord }: `firstStartsWord` mirrors the
// flag of the first emitted segment so the cross-update accumulator
// knows whether to prepend a space.
function buildSegmentText (items) {
  let text = ''
  let firstStartsWord = true
  let isFirst = true
  for (const s of items) {
    if (!s || !s.text || !s.toAppend) continue
    const sw = s.startsWord !== false
    if (isFirst) {
      firstStartsWord = sw
      text = s.text
      isFirst = false
    } else {
      text += (sw ? ' ' : '') + s.text
    }
  }
  return { text: text.replace(/\s+/g, ' '), firstStartsWord }
}

function parseArgs () {
  const args = {
    model: null,
    accumulate: false,
    capture: null,
    chunkMs: null
  }
  const argv = Bare.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--model' || a === '-m') args.model = argv[++i]
    else if (a === '--accumulate') args.accumulate = true
    else if (a === '--capture' || a === '-c') args.capture = argv[++i]
    else if (a === '--chunk-ms') {
      const v = parseInt(argv[++i], 10)
      if (Number.isFinite(v) && v >= 200) args.chunkMs = v
    }
  }
  return args
}

async function main () {
  const args = parseArgs()
  if (!args.model) {
    console.error('Usage: bare examples/live-mic.js --model <gguf> [--accumulate] [--chunk-ms <ms>] [--capture "<sox cmd>"]')
    process.exit(1)
  }

  setupLogger(addonLogging)
  let stopping = false

  const modelPath = path.resolve(args.model)
  if (!validatePaths({ model: modelPath })) {
    addonLogging.releaseLogger()
    process.exit(1)
  }

  console.log(`Loading ${modelPath}...`)

  const model = new TranscriptionParakeet({
    files: { model: modelPath },
    config: {
      parakeetConfig: {
        streaming: true,
        streamingChunkMs: args.chunkMs ?? 2000,
        useGPU: true
      }
    }
  })
  await model.load()
  console.log('Listening (Ctrl-C to stop)...\n')

  const captureCmd = args.capture && args.capture.length > 0 ? args.capture : CAPTURE_CMD
  const [captureBin, ...captureArgs] = captureCmd.split(' ')
  let child
  try {
    child = subprocess.spawn(captureBin, captureArgs,
      { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.error(`\n'${captureBin}' not found on PATH.`)
      console.error('Install sox (brew install sox / apt install sox / choco install sox / winget install ChrisBagwell.SoX).')
    } else {
      console.error(`\nFailed to spawn capture command: ${err.message}`)
    }
    addonLogging.releaseLogger()
    process.exit(1)
  }
  child.on('error', (err) => {
    console.error(`\nCapture command failed: ${err.message}`)
    process.exit(1)
  })

  let firstAudioSeen = false
  let stderrBuf = ''
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8')
    if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192)
  })

  let lineOpen = false
  function flushLine () {
    if (lineOpen) {
      process.stdout.write('\n')
      lineOpen = false
    }
  }
  function emitTranscript (text, firstStartsWord) {
    if (isSilenceText(text)) {
      if (args.accumulate) flushLine()
      return
    }
    const ts = new Date().toISOString().slice(11, 19)
    if (args.accumulate) {
      if (!lineOpen) {
        process.stdout.write(`[${ts}] ${text}`)
        lineOpen = true
      } else {
        process.stdout.write((firstStartsWord ? ' ' : '') + text)
      }
    } else {
      console.log(`[${ts}] ${text}`)
    }
  }

  const audioStream = pushableStream()
  child.stdout.on('data', (chunk) => {
    if (!firstAudioSeen) firstAudioSeen = true
    if (!stopping) audioStream.push(chunk)
  })

  const streamingConfig = {}
  if (args.chunkMs !== null) streamingConfig.chunkMs = args.chunkMs

  const runPromise = (async () => {
    const response = await model.runStreaming(audioStream, streamingConfig)
    await response
      .onUpdate(out => {
        const items = Array.isArray(out) ? out : [out]
        const { text, firstStartsWord } = buildSegmentText(items)
        emitTranscript(text.trim(), firstStartsWord)
      })
      .await()
  })()

  async function shutdown () {
    if (stopping) return
    stopping = true
    console.log('\nStopping...')
    try { child.kill('SIGTERM') } catch (e) { /* ignore */ }
    audioStream.end()
    try { await runPromise } catch (e) { /* swallow */ }
    flushLine()
    try { await model.unload() } catch (e) { /* ignore */ }
    addonLogging.releaseLogger()
    process.exit(0)
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  child.on('exit', (code, signal) => {
    if (!firstAudioSeen && !stopping) {
      console.error(`\nCapture command exited before producing audio (code=${code}, signal=${signal}).`)
      const tail = stderrBuf.trim()
      if (tail) {
        console.error('--- sox stderr ---')
        console.error(tail)
        console.error('------------------')
      }
      console.error('Hints:')
      console.error('  - On Windows, try: --capture "sox -t waveaudio default -t raw -r 16000 -b 16 -c 1 -e signed-integer -L -"')
      console.error('  - Verify a default recording device exists (Settings -> System -> Sound -> Input).')
      console.error('  - Confirm SoX can list audio devices: sox -V6 -d -t raw -r 16000 -c 1 -e signed-integer -b 16 -L - 2>&1 | head')
    }
    shutdown()
  })
}

main().catch(err => {
  console.error('Error:', err)
  addonLogging.releaseLogger()
  process.exit(1)
})
