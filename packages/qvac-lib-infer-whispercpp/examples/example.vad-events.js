'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const TranscriptionWhispercpp = require('../index.js')
const binding = require('../binding.js')

const LOG_PRIORITIES = ['ERROR', 'WARNING', 'INFO', 'DEBUG']
binding.setLogger((priority, message) => {
  const priorityName = LOG_PRIORITIES[priority] || `UNKNOWN(${priority})`
  console.log(`[C++ ${priorityName}] ${message}`)
})

/**
 * Example: Consuming `vadState` and `endOfTurn` events during streaming transcription
 *
 * Demonstrates how a consumer would subscribe to the two Silero-VAD derived
 * lifecycle events that the addon streaming path emits alongside transcription
 * segments:
 *
 *   - `vadState`   Fired whenever the VAD crosses a speech / silence boundary.
 *                  Payload shape:
 *                    {
 *                      active: boolean,      // true = speech just started,
 *                                            // false = speech just ended
 *                      timestamp: number,    // seconds from the start of the stream
 *                      probability?: number  // optional: Silero confidence [0, 1]
 *                    }
 *
 *   - `endOfTurn`  Fired when a "conversational turn" finishes: the VAD has
 *                  observed at least `minSilenceDurationMs` of silence after
 *                  the last speech segment. Payload shape:
 *                    {
 *                      timestamp: number,    // seconds from the start of the stream
 *                                            // (= turnEnd + silence window)
 *                      turnStart: number,    // seconds; onset of first speech in the turn
 *                      turnEnd: number,      // seconds; offset of last speech in the turn
 *                      silenceMs: number     // ms of trailing silence used to close the turn
 *                    }
 *
 * Both events flow through the same `response` object returned by
 * `model.runStreaming(audioStream)`. `QvacResponse` extends `EventEmitter`,
 * so listeners are attached with the raw `response.on(eventName, handler)` API
 * (the existing `response.onUpdate(...)` handler continues to deliver
 * transcription segments).
 *
 * NOTE: The events themselves are emitted by the addon. If you are running
 * this example against a build that has not yet been updated with the
 * companion "Whisper addon: support VadState / EndOfTurn events" change, you
 * will still see transcription output, but the `[VAD ...]` and `--- turn ...`
 * lines will be silent. The summary at the end reports how many events of
 * each type were received so the integration is easy to verify.
 *
 * Usage: bare examples/example.vad-events.js [audioPath] [modelPath] [vadModelPath]
 */

const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE

async function main () {
  const args = process.argv.slice(2)
  const modelsDir = path.join(__dirname, '..', 'models')
  const audioFilePath = args[0] || path.join(__dirname, 'samples', 'sample.raw')
  const modelPath = args[1] || path.join(modelsDir, 'ggml-tiny.bin')
  const vadModelPath = args[2] || path.join(modelsDir, 'ggml-silero-v5.1.2.bin')

  if (!fs.existsSync(modelPath)) {
    console.error(`Model file not found at ${modelPath}`)
    process.exit(1)
  }
  if (!fs.existsSync(audioFilePath)) {
    console.error(`Audio file not found at ${audioFilePath}`)
    process.exit(1)
  }
  if (!fs.existsSync(vadModelPath)) {
    console.error(`VAD model not found at ${vadModelPath}`)
    process.exit(1)
  }

  console.log('=== VAD Events (vadState + endOfTurn) Example ===\n')
  console.log(`Model:     ${modelPath}`)
  console.log(`VAD Model: ${vadModelPath}`)
  console.log(`Audio:     ${audioFilePath}\n`)

  const model = new TranscriptionWhispercpp(
    {
      files: {
        model: modelPath,
        vadModel: vadModelPath
      },
      opts: { stats: true }
    },
    {
      whisperConfig: {
        language: 'en',
        audio_format: 's16le',
        temperature: 0.0,
        suppress_nst: true,
        vad_params: {
          threshold: 0.5,
          min_silence_duration_ms: 500,
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

  const audioStream = fs.createReadStream(audioFilePath, {
    highWaterMark: BYTES_PER_SECOND
  })

  const { size: fileSize } = fs.statSync(audioFilePath)
  const totalDurationS = (fileSize / BYTES_PER_SAMPLE) / SAMPLE_RATE
  console.log(`Audio duration: ${totalDurationS.toFixed(1)}s\n`)

  const segments = []
  const vadStateEvents = []
  const turns = []
  let currentTurnSegments = []
  const startTime = Date.now()

  const response = await model.runStreaming(audioStream)

  // Transcription segments continue to arrive via onUpdate().
  // They are accumulated into the "current turn" bucket until an `endOfTurn`
  // event closes it.
  response.onUpdate((data) => {
    const items = Array.isArray(data) ? data : [data]
    for (const item of items) {
      segments.push(item)
      currentTurnSegments.push(item)
      const text = (item.text || '').trim()
      if (text) {
        console.log(
          `[segment ${segments.length}] [${fmt(item.start)}s - ${fmt(item.end)}s] ${text}`
        )
      }
    }
  })

  // New: VAD state transitions.
  response.on('vadState', (state) => {
    vadStateEvents.push(state)
    const label = state.active ? 'speech_started' : 'speech_ended'
    const prob = typeof state.probability === 'number'
      ? ` (p=${state.probability.toFixed(2)})`
      : ''
    console.log(`[VAD ${label} @ ${fmt(state.timestamp)}s]${prob}`)
  })

  // New: conversational turn boundary.
  response.on('endOfTurn', (turn) => {
    const turnText = currentTurnSegments
      .map(s => (s.text || '').trim())
      .filter(t => t.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    turns.push({ ...turn, text: turnText, segments: currentTurnSegments })
    currentTurnSegments = []

    const silenceMs = typeof turn.silenceMs === 'number'
      ? ` ${turn.silenceMs}ms silence`
      : ''
    console.log(
      `--- turn ${turns.length} @ ${fmt(turn.timestamp)}s ` +
      `(${fmt(turn.turnStart)}s–${fmt(turn.turnEnd)}s,${silenceMs}) ---`
    )
    if (turnText) {
      console.log(`    "${turnText}"`)
    }
  })

  try {
    await response.await()

    // If the stream ended without a closing `endOfTurn`, flush any trailing
    // segments as an implicit final turn so the summary still reflects
    // everything that was transcribed.
    if (currentTurnSegments.length > 0) {
      const trailingText = currentTurnSegments
        .map(s => (s.text || '').trim())
        .filter(t => t.length > 0)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      turns.push({
        timestamp: currentTurnSegments.at(-1)?.end ?? 0,
        turnStart: currentTurnSegments[0]?.start ?? 0,
        turnEnd: currentTurnSegments.at(-1)?.end ?? 0,
        silenceMs: null,
        text: trailingText,
        segments: currentTurnSegments,
        implicit: true
      })
      currentTurnSegments = []
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log('\n=== RESULTS ===')
    console.log(`Segments:       ${segments.length}`)
    console.log(`vadState events:${vadStateEvents.length.toString().padStart(5)}`)
    console.log(`endOfTurn events:${turns.filter(t => !t.implicit).length.toString().padStart(4)}`)
    console.log(`Turns (incl. implicit final): ${turns.length}`)
    console.log(`Processing time: ${elapsed}s`)
    console.log(`Audio duration:  ${totalDurationS.toFixed(1)}s`)

    if (turns.length > 0) {
      console.log('\n=== TRANSCRIPT BY TURN ===')
      for (const [i, turn] of turns.entries()) {
        const marker = turn.implicit ? ' (implicit)' : ''
        console.log(
          `turn ${i + 1}${marker} [${fmt(turn.turnStart)}s–${fmt(turn.turnEnd)}s]: ${turn.text || '(empty)'}`
        )
      }
      console.log('=== END ===\n')
    } else {
      console.log('\nNo transcription output received.\n')
    }

    if (vadStateEvents.length === 0 && turns.filter(t => !t.implicit).length === 0) {
      console.log(
        'NOTE: No `vadState` or `endOfTurn` events were received. This example\n' +
        '      is written against the event API that the whisper addon exposes\n' +
        '      once the companion "Whisper: support VadState and EndOfTurn\n' +
        '      events" change lands. Until then, transcription segments still\n' +
        '      flow through `response.onUpdate(...)` exactly as in\n' +
        '      example.streaming-vad.js.'
      )
    }
  } catch (err) {
    console.error('Streaming transcription failed:', err.message)
  }

  await model.destroy()
  binding.releaseLogger()
}

function fmt (seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '?'
  return seconds.toFixed(1)
}

main().catch(err => {
  console.error(err)
  binding.releaseLogger()
  process.exit(1)
})
