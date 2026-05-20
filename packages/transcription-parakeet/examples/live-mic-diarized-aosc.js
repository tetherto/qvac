'use strict'

/**
 * Live-mic transcription + diarization example with full AOSC control.
 *
 * This is the v2.1-focused counterpart of `examples/live-mic-diarized.js`.
 * Both files share the same duplex pattern (two `runStreaming()`
 * sessions fanned from a single sox capture, with the ASR transcript
 * tagged by the latest Sortformer speaker_id). What this file adds is
 * explicit CLI control of the AOSC (Audio-Online Speaker Cache) knobs
 * parakeet-cpp exposes for v2.1 Sortformer streaming:
 *
 *   --spk-cache-enable {true|false}     Toggle AOSC. Defaults to true.
 *                                       Set false to force a v2.1 GGUF
 *                                       onto the v1 sliding-window
 *                                       path (A/B comparison).
 *   --spk-cache-len <rows>              Long-term speaker-cache rows
 *                                       (default 188 ≈ 15 s).
 *   --fifo-len <rows>                   FIFO warmup buffer rows
 *                                       (default 188).
 *   --chunk-left-context-ms <ms>        Encoder left context, ~1 frame
 *                                       (default 80).
 *   --chunk-right-context-ms <ms>       Encoder right context, ~7 frames
 *                                       (default 560). Adds directly to
 *                                       per-chunk emission latency.
 *   --spk-cache-update-period <count>   FIFO-overflow pop-out count
 *                                       (default 144). How many frames
 *                                       get promoted into the long-term
 *                                       cache each time the FIFO fills.
 *
 * Background -- what AOSC fixes:
 * v1 / v2 Sortformer streams use a fixed-size sliding-history window
 * inside the engine. Once two voices have been seen, the model's
 * per-chunk decisions are permutation-invariant; if one speaker goes
 * silent long enough to roll out of the window, its slot identity can
 * silently drift onto a different physical voice when it returns. v2.1
 * replaces the sliding window with a NeMo-port speaker cache that
 * anchors each slot to its accumulated embedding, so the same physical
 * speaker comes back to the same `Speaker N` tag across silences.
 *
 * For the upstream API + algorithm details, see
 * `parakeet-cpp/include/parakeet/diarization.h` and the upstream PRs
 * that introduced this feature in qvac-ext-lib-whisper.cpp (PR #22
 * commit e6ba38c, PR #24 commit 08df2e7).
 *
 * Usage:
 *   bare examples/live-mic-diarized-aosc.js \
 *        --asr-model <ctc-or-tdt-gguf> \
 *        --diar-model <v2.1-sortformer-gguf> \
 *        [--accumulate] [--chunk-ms <ms>] [--capture "<sox cmd>"] \
 *        [--spk-cache-enable {true|false}] [--spk-cache-len <rows>] \
 *        [--fifo-len <rows>] [--chunk-left-context-ms <ms>] \
 *        [--chunk-right-context-ms <ms>] [--spk-cache-update-period <count>]
 *
 * Notes:
 *  - The AOSC knobs are silently ignored on v1/v2 GGUFs and on
 *    non-Sortformer models. The engine detects v2.1 via the GGUF
 *    metadata tag `parakeet.model_variant`.
 *  - On Windows, if sox exits without producing audio, override capture:
 *      --capture "sox -t waveaudio default -t raw -r 16000 -b 16 -c 1 -e signed-integer -L -"
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

function parseSortformerSpeakerId (text) {
  const m = typeof text === 'string'
    ? text.match(/Speaker\s+(\d+)/)
    : null
  return m ? parseInt(m[1], 10) : -1
}

function parseBoolFlag (value) {
  if (value === undefined || value === null) return undefined
  const normalised = String(value).toLowerCase()
  if (normalised === 'true' || normalised === '1' || normalised === 'yes') return true
  if (normalised === 'false' || normalised === '0' || normalised === 'no') return false
  return undefined
}

function parsePositiveInt (value) {
  const n = parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function parseNonNegativeInt (value) {
  const n = parseInt(value, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function parseArgs () {
  const args = {
    asrModel: null,
    diarModel: null,
    accumulate: false,
    capture: null,
    chunkMs: null,
    spkCacheEnable: undefined,
    spkCacheLen: null,
    fifoLen: null,
    chunkLeftContextMs: null,
    chunkRightContextMs: null,
    spkCacheUpdatePeriod: null
  }
  const argv = Bare.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--asr-model' || a === '-m') args.asrModel = argv[++i]
    else if (a === '--diar-model' || a === '-d') args.diarModel = argv[++i]
    else if (a === '--accumulate') args.accumulate = true
    else if (a === '--capture' || a === '-c') args.capture = argv[++i]
    else if (a === '--chunk-ms') {
      const v = parsePositiveInt(argv[++i])
      if (v !== null && v >= 200) args.chunkMs = v
    } else if (a === '--spk-cache-enable') {
      const v = parseBoolFlag(argv[++i])
      if (v !== undefined) args.spkCacheEnable = v
    } else if (a === '--spk-cache-len') args.spkCacheLen = parsePositiveInt(argv[++i])
    else if (a === '--fifo-len') args.fifoLen = parsePositiveInt(argv[++i])
    else if (a === '--chunk-left-context-ms') args.chunkLeftContextMs = parseNonNegativeInt(argv[++i])
    else if (a === '--chunk-right-context-ms') args.chunkRightContextMs = parseNonNegativeInt(argv[++i])
    else if (a === '--spk-cache-update-period') args.spkCacheUpdatePeriod = parsePositiveInt(argv[++i])
  }
  return args
}

function buildDiarConfig (args) {
  const config = {
    streaming: true,
    streamingChunkMs: args.chunkMs ?? 2000,
    useGPU: true
  }
  if (args.spkCacheEnable !== undefined) config.streamingSpkCacheEnable = args.spkCacheEnable
  if (args.spkCacheLen !== null) config.streamingSpkCacheLen = args.spkCacheLen
  if (args.fifoLen !== null) config.streamingFifoLen = args.fifoLen
  if (args.chunkLeftContextMs !== null) config.streamingChunkLeftContextMs = args.chunkLeftContextMs
  if (args.chunkRightContextMs !== null) config.streamingChunkRightContextMs = args.chunkRightContextMs
  if (args.spkCacheUpdatePeriod !== null) config.streamingSpkCacheUpdatePeriod = args.spkCacheUpdatePeriod
  return config
}

function describeAoscConfig (config) {
  const parts = []
  if ('streamingSpkCacheEnable' in config) parts.push(`spkCacheEnable=${config.streamingSpkCacheEnable}`)
  if ('streamingSpkCacheLen' in config) parts.push(`spkCacheLen=${config.streamingSpkCacheLen}`)
  if ('streamingFifoLen' in config) parts.push(`fifoLen=${config.streamingFifoLen}`)
  if ('streamingChunkLeftContextMs' in config) parts.push(`chunkLeftContextMs=${config.streamingChunkLeftContextMs}`)
  if ('streamingChunkRightContextMs' in config) parts.push(`chunkRightContextMs=${config.streamingChunkRightContextMs}`)
  if ('streamingSpkCacheUpdatePeriod' in config) parts.push(`spkCacheUpdatePeriod=${config.streamingSpkCacheUpdatePeriod}`)
  return parts.length === 0 ? '(all AOSC defaults)' : parts.join(' ')
}

async function main () {
  const args = parseArgs()
  if (!args.asrModel || !args.diarModel) {
    console.error('Usage: bare examples/live-mic-diarized-aosc.js --asr-model <gguf> --diar-model <v2.1-gguf> [--accumulate] [--chunk-ms <ms>] [--capture "<sox cmd>"] [--spk-cache-enable {true|false}] [--spk-cache-len <rows>] [--fifo-len <rows>] [--chunk-left-context-ms <ms>] [--chunk-right-context-ms <ms>] [--spk-cache-update-period <count>]')
    process.exit(1)
  }

  setupLogger(addonLogging)
  let stopping = false

  const asrPath = path.resolve(args.asrModel)
  const diarPath = path.resolve(args.diarModel)
  if (!validatePaths({ model: asrPath })) { addonLogging.releaseLogger(); process.exit(1) }
  if (!validatePaths({ model: diarPath })) { addonLogging.releaseLogger(); process.exit(1) }

  console.log(`Loading ASR: ${asrPath}`)
  console.log(`Loading DIAR: ${diarPath}`)

  const diarConfig = buildDiarConfig(args)
  console.log(`AOSC config: ${describeAoscConfig(diarConfig)}`)

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
    config: { parakeetConfig: diarConfig }
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
