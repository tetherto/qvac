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
 * tuning knobs from the CLI, see `examples/live-mic-diarized-aosc.js`.
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
 * Usage:
 *   bare examples/live-mic-diarized.js \
 *        --asr-model <gguf> --diar-model <gguf> \
 *        [--accumulate] [--chunk-ms <ms>] [--capture "<sox cmd>"]
 *
 * On Windows, if sox exits without producing audio, override capture:
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
  '[Model not ready]',
  '[No speakers detected]'
])

function isSilenceText (text) {
  return text.length === 0 || SILENCE_SENTINELS.has(text)
}

// Streaming TDT/CTC sometimes emits a word as two segments straddling
// a chunk boundary; parakeet-cpp surfaces a per-segment `startsWord`
// flag we use to gate the inserted separator so "see" + "if" stays
// "see if" while "pun" + "ctuation" rejoins into "punctuation". See
// live-mic.js for full rationale.
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
    asrModel: null,
    diarModel: null,
    accumulate: false,
    capture: null,
    chunkMs: null
  }
  const argv = Bare.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--asr-model' || a === '-m') args.asrModel = argv[++i]
    else if (a === '--diar-model' || a === '-d') args.diarModel = argv[++i]
    else if (a === '--accumulate') args.accumulate = true
    else if (a === '--capture' || a === '-c') args.capture = argv[++i]
    else if (a === '--chunk-ms') {
      const v = parseInt(argv[++i], 10)
      if (Number.isFinite(v) && v >= 200) args.chunkMs = v
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
function parseSortformerSpeakerId (text) {
  const m = typeof text === 'string'
    ? text.match(/Speaker\s+(\d+)/)
    : null
  return m ? parseInt(m[1], 10) : -1
}

async function main () {
  const args = parseArgs()
  if (!args.asrModel || !args.diarModel) {
    console.error('Usage: bare examples/live-mic-diarized.js --asr-model <gguf> --diar-model <gguf> [--accumulate] [--chunk-ms <ms>] [--capture "<sox cmd>"]')
    process.exit(1)
  }

  setupLogger(addonLogging)
  let stopping = false

  const asrPath = path.resolve(args.asrModel)
  const diarPath = path.resolve(args.diarModel)
  if (!validatePaths({ model: asrPath })) { addonLogging.releaseLogger(); process.exit(1) }
  if (!validatePaths({ model: diarPath })) { addonLogging.releaseLogger(); process.exit(1) }

  console.log(`Loading ${asrPath}...`)
  console.log(`Loading ${diarPath}...`)

  const asr = new TranscriptionParakeet({
    files: { model: asrPath },
    config: {
      parakeetConfig: {
        streaming: true,
        streamingChunkMs: args.chunkMs ?? 2000,
        useGPU: true
      }
    }
  })
  const diar = new TranscriptionParakeet({
    files: { model: diarPath },
    config: {
      parakeetConfig: {
        streaming: true,
        streamingChunkMs: args.chunkMs ?? 2000,
        streamingHistoryMs: STREAMING_HISTORY_MS,
        useGPU: true
      }
    }
  })

  await asr.load()
  await diar.load()
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
  let lineSpeaker = null
  let lastSpeaker = -1

  function flushLine () {
    if (lineOpen) {
      process.stdout.write('\n')
      lineOpen = false
      lineSpeaker = null
    }
  }
  function emitTranscript (speaker, text, firstStartsWord) {
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

  const asrStream = pushableStream()
  const diarStream = pushableStream()
  child.stdout.on('data', (chunk) => {
    if (!firstAudioSeen) firstAudioSeen = true
    if (stopping) return
    asrStream.push(chunk)
    diarStream.push(chunk)
  })

  const streamingConfig = {}
  if (args.chunkMs !== null) streamingConfig.chunkMs = args.chunkMs

  const diarRunPromise = (async () => {
    const response = await diar.runStreaming(diarStream, streamingConfig)
    await response
      .onUpdate(out => {
        const items = Array.isArray(out) ? out : [out]
        // Update lastSpeaker from the latest non-silence segment in
        // the batch. We tag the ASR transcript with whatever ID
        // Sortformer reported; see the file header for the caveat
        // about engine-side drift.
        for (let i = items.length - 1; i >= 0; i--) {
          const s = items[i]
          if (!s || !s.text || isSilenceText(s.text)) continue
          const id = parseSortformerSpeakerId(s.text)
          if (id >= 0) {
            lastSpeaker = id
            break
          }
        }
      })
      .await()
  })()

  const asrRunPromise = (async () => {
    const response = await asr.runStreaming(asrStream, streamingConfig)
    await response
      .onUpdate(out => {
        const items = Array.isArray(out) ? out : [out]
        const { text, firstStartsWord } = buildSegmentText(items)
        emitTranscript(lastSpeaker, text.trim(), firstStartsWord)
      })
      .await()
  })()

  async function shutdown () {
    if (stopping) return
    stopping = true
    console.log('\nStopping...')
    try { child.kill('SIGTERM') } catch (e) { /* ignore */ }
    asrStream.end()
    diarStream.end()
    try { await Promise.all([asrRunPromise, diarRunPromise]) } catch (e) { /* swallow */ }
    flushLine()
    try { await asr.unload() } catch (e) { /* ignore */ }
    try { await diar.unload() } catch (e) { /* ignore */ }
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
