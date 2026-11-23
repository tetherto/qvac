'use strict'

/**
 * Live-mic transcription + diarization example (duplex streaming).
 *
 * Captures the default input device via `sox -d`, fans each chunk
 * out to two pushable async-iterables, and feeds both to
 * `model.runStreaming()` -- one ASR session, one Sortformer session.
 * The diarization side updates `lastSpeaker` from the latest emitted
 * Sortformer segment; the ASR side tags each printed transcript with
 * `lastSpeaker`. Press Ctrl-C to flush and exit.
 *
 * Recommended `--diar-model`: the v2.1 Sortformer GGUF
 * (`diar_streaming_sortformer_4spk-v2.1.q8_0.gguf`). parakeet-cpp
 * detects v2.1 from the GGUF metadata tag
 * `parakeet.model_variant == "sortformer-streaming-v2.1-aosc"` and
 * enables AOSC (Audio-Online Speaker Cache) automatically, which
 * anchors speaker slots across silence and re-entry and largely
 * removes the drift caveat described below.
 *
 * For an AOSC-aware variant that also exposes the speaker-cache
 * tuning knobs from the CLI, see `examples/parakeet-live-mic-diarized-aosc.js`.
 *
 * v1 caveat (kept for users running the older v1 GGUF): Sortformer's
 * streaming session is permutation-invariant per chunk and prone to
 * occasional speaker-ID drift on continuous single-speaker stretches
 * once two voices have been seen in the rolling-history window.
 * parakeet-cpp documents this behaviour in
 * `parakeet-cpp/include/parakeet/diarization.h:80-82`. Fixing it
 * properly required per-segment voice embeddings (now solved by v2.1's
 * AOSC) -- this example therefore renders the raw Sortformer ID and
 * accepts the occasional mis-tag rather than try to second-guess the
 * model in JS.
 *
 * Use a cache-aware ASR checkpoint (Parakeet Unified RNN-T or Nemotron).
 * Speaker tags use the latest Sortformer result as a live approximation.
 * Set the ASR cadence with --asr-chunk-ms and Sortformer cadence with
 * --diar-chunk-ms. The legacy --chunk-ms flag sets the Sortformer cadence.
 *
 * Usage:
 *   bare examples/parakeet-live-mic-diarized.js \
 *        --asr-model <unified-or-nemotron-gguf> --diar-model <gguf> \
 *        [--accumulate] [--asr-chunk-ms <ms>] [--diar-chunk-ms <ms>] [--capture "<sox cmd>"]
 *
 * On Windows, if sox exits without producing audio, override capture:
 *   --capture "sox -t waveaudio default -t raw -r 16000 -b 16 -c 1 -e signed-integer -L -"
 */

/* global Bare */
const path = require('bare-path')
const process = require('bare-process')
const subprocess = require('bare-subprocess')
const ASRGgml = require('../index.js')
const addonLogging = require('../addonLogging.js')
const { setupLogger, validatePaths, pushableStream } = require('./parakeet-utils.js')
const {
  parseMicChunkMs,
  buildMicChunkOptions,
  startDiarizedMic,
  finishDiarizedMic,
  spawnMicCapture
} = require('./parakeet-diarized-mic-options.js')

const CAPTURE_CMD = 'sox -d -t raw -r 16000 -b 16 -c 1 -e signed-integer -L -'

const SILENCE_SENTINELS = new Set([
  '[No speech detected]',
  '[Audio too short]',
  '[Model not ready]',
  '[No speakers detected]'
])

function isSilenceText(text) {
  return text.length === 0 || SILENCE_SENTINELS.has(text)
}

// Join segments using the model's word-boundary flag so split words stay intact.
function buildSegmentText(items) {
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

function parseArgs() {
  const args = {
    asrModel: null,
    diarModel: null,
    accumulate: false,
    capture: null
  }
  const argv = Bare.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--asr-model' || a === '-m') args.asrModel = argv[++i]
    else if (a === '--diar-model' || a === '-d') args.diarModel = argv[++i]
    else if (a === '--accumulate') args.accumulate = true
    else if (a === '--capture' || a === '-c') args.capture = argv[++i]
    else if (a === '--asr-chunk-ms') args.asrChunkMs = parseMicChunkMs(a, argv[++i])
    else if (a === '--diar-chunk-ms' || a === '--chunk-ms') {
      args.diarChunkMs = parseMicChunkMs(a, argv[++i])
    }
  }
  return args
}

// Pin the Sortformer rolling-history window at parakeet-cpp's default
// (30 s). Pushing past it on a v1 GGUF puts the input outside the
// window the underlying model was trained on, which empirically causes
// the engine to collapse all voices onto sortformer_0.
//
// On a v2.1 GGUF, AOSC is auto-enabled and supersedes this rolling
// window with a NeMo-port speaker cache. parakeet-cpp ignores
// `history_ms` for v2.1 sessions, so this constant is harmless either
// way and is kept for backwards compatibility with v1 GGUFs.
const STREAMING_HISTORY_MS = 30000

// Pull the Sortformer speaker_id out of the addon's segment text
// ("Speaker N: HH:MM:SS.fff - HH:MM:SS.fff"). Returns -1 if the text
// doesn't match the expected format.
function parseSortformerSpeakerId(text) {
  const m = typeof text === 'string' ? text.match(/Speaker\s+(\d+)/) : null
  return m ? parseInt(m[1], 10) : -1
}

async function main() {
  const args = parseArgs()
  const { asrOptions, diarStreamingChunkMs } = buildMicChunkOptions(args)
  if (!args.asrModel || !args.diarModel) {
    console.error(
      'Usage: bare examples/parakeet-live-mic-diarized.js --asr-model <unified-or-nemotron-gguf> --diar-model <gguf> [--accumulate] [--asr-chunk-ms <ms>] [--diar-chunk-ms <ms>] [--capture "<sox cmd>"]'
    )
    process.exit(1)
  }

  setupLogger(addonLogging)
  let stopping = false

  const asrPath = path.resolve(args.asrModel)
  const diarPath = path.resolve(args.diarModel)
  if (!validatePaths({ model: asrPath })) {
    addonLogging.releaseLogger()
    process.exit(1)
  }
  if (!validatePaths({ model: diarPath })) {
    addonLogging.releaseLogger()
    process.exit(1)
  }

  console.log(`Loading ${asrPath}...`)
  console.log(`Loading ${diarPath}...`)

  const asr = new ASRGgml({
    files: { model: asrPath },
    config: {
      engine: 'parakeet',
      parakeetConfig: {
        useGPU: true
      }
    }
  })
  const diar = new ASRGgml({
    files: { model: diarPath },
    config: {
      engine: 'parakeet',
      parakeetConfig: {
        streaming: true,
        streamingChunkMs: diarStreamingChunkMs,
        streamingHistoryMs: STREAMING_HISTORY_MS,
        useGPU: true
      }
    }
  })

  let lineOpen = false
  let lineSpeaker = null
  let lastSpeaker = -1

  function flushLine() {
    if (lineOpen) {
      process.stdout.write('\n')
      lineOpen = false
      lineSpeaker = null
    }
  }
  function emitTranscript(speaker, text, firstStartsWord) {
    if (isSilenceText(text)) {
      if (args.accumulate) flushLine()
      return
    }
    const tag = speaker >= 0 ? `speaker_${speaker}` : 'speaker_?'
    const ts = new Date().toISOString().slice(11, 19)
    if (args.accumulate) {
      if (lineOpen && lineSpeaker !== speaker) flushLine()
      if (!lineOpen) {
        process.stdout.write(`[${ts}] ${tag}: ${text}`)
        lineOpen = true
        lineSpeaker = speaker
      } else {
        process.stdout.write((firstStartsWord ? ' ' : '') + text)
      }
    } else {
      console.log(`[${ts}] ${tag}: ${text}`)
    }
  }

  function updateDiarization(out) {
    const items = Array.isArray(out) ? out : [out]
    for (let i = items.length - 1; i >= 0; i--) {
      const segment = items[i]
      if (!segment || !segment.text || isSilenceText(segment.text)) continue
      const id = parseSortformerSpeakerId(segment.text)
      if (id >= 0) {
        lastSpeaker = id
        break
      }
    }
  }

  function updateTranscript(out) {
    const items = Array.isArray(out) ? out : [out]
    const { text, firstStartsWord } = buildSegmentText(items)
    emitTranscript(lastSpeaker, text.trim(), firstStartsWord)
  }

  const asrStream = pushableStream()
  const diarStream = pushableStream()
  const asrSession = {
    model: asr,
    stream: asrStream,
    options: asrOptions,
    onUpdate: updateTranscript
  }
  const diarSession = { model: diar, stream: diarStream, onUpdate: updateDiarization }
  const { child, runs } = await startDiarizedMic(asrSession, diarSession, () =>
    spawnMicCapture(subprocess, args.capture || CAPTURE_CMD)
  )
  console.log('Listening (Ctrl-C to stop)...\n')

  let firstAudioSeen = false
  let stderrBuf = ''
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8')
    if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192)
  })
  child.stdout.on('data', (chunk) => {
    if (stopping) return
    firstAudioSeen = true
    asrStream.push(chunk)
    diarStream.push(chunk)
  })

  async function shutdown(error) {
    if (stopping) return
    stopping = true
    if (error) console.error(error.message)
    console.log('\nStopping...')
    try {
      child.kill('SIGTERM')
    } catch {
      // The capture process may have already exited.
    }
    await finishDiarizedMic([asrSession, diarSession], runs)
    flushLine()
    addonLogging.releaseLogger()
    process.exit(error ? 1 : 0)
  }

  Promise.all(runs).catch(shutdown)
  child.on('error', shutdown)
  process.once('SIGINT', () => shutdown())
  process.once('SIGTERM', () => shutdown())
  child.on('exit', (code, signal) => {
    if (!firstAudioSeen && !stopping) {
      console.error(
        `\nCapture command exited before producing audio (code=${code}, signal=${signal}).`
      )
      const tail = stderrBuf.trim()
      if (tail) {
        console.error('--- sox stderr ---')
        console.error(tail)
        console.error('------------------')
      }
      console.error('Hints:')
      console.error(
        '  - On Windows, try: --capture "sox -t waveaudio default -t raw -r 16000 -b 16 -c 1 -e signed-integer -L -"'
      )
      console.error(
        '  - Verify a default recording device exists (Settings -> System -> Sound -> Input).'
      )
      console.error(
        '  - Confirm SoX can list audio devices: sox -V6 -d -t raw -r 16000 -c 1 -e signed-integer -b 16 -L - 2>&1 | head'
      )
    }
    shutdown()
  })
}

main().catch((err) => {
  console.error('Error:', err)
  addonLogging.releaseLogger()
  process.exit(1)
})
