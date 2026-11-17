'use strict'

// Argument parsing, long-form window arithmetic and Core ML reporting for the
// TranscribePsy example, kept free of bare modules so the node test suite can
// load it.

const ENCODER_FRAMES_PER_SECOND = 12.5
const DEFAULT_OVERLAP = 0.25
const MAX_OVERLAP = 0.5
const NO_CONTEXT_FRAMES = -1
// Routes of the full TranscribePsy-250M-EU model: its English trunk, its CAFE
// adapters, or the language gate choosing between them.
const EU_LANGUAGES = ['auto', 'en', 'other']

const USAGE =
  'Usage: bare examples/parakeet-transcribepsy-transcribe.js --model <gguf> --audio <file> ' +
  '[--window-sec <seconds>] [--overlap <fraction, 0 to 0.5>] [--language <auto|en|other>]'

function parseWindowSeconds(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--window-sec expects a positive number of seconds (got '${value}')\n${USAGE}`)
  }
  return seconds
}

function parseOverlap(value) {
  const overlap = Number(value)
  if (!Number.isFinite(overlap) || overlap < 0 || overlap > MAX_OVERLAP) {
    throw new Error(
      `--overlap expects a fraction from 0 to ${MAX_OVERLAP} (got '${value}')\n${USAGE}`
    )
  }
  return overlap
}

function parseLanguage(value) {
  if (!EU_LANGUAGES.includes(value)) {
    throw new Error(
      `--language expects one of ${EU_LANGUAGES.join(', ')} (got '${value}')\n${USAGE}`
    )
  }
  return value
}

function parseLongFormArguments(argv) {
  const args = {
    model: null,
    audio: null,
    windowSeconds: null,
    overlap: DEFAULT_OVERLAP,
    language: null
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--model' || argument === '-m') args.model = argv[++index]
    else if (argument === '--audio' || argument === '-a') args.audio = argv[++index]
    else if (argument === '--window-sec') args.windowSeconds = parseWindowSeconds(argv[++index])
    else if (argument === '--overlap') args.overlap = parseOverlap(argv[++index])
    else if (argument === '--language') args.language = parseLanguage(argv[++index])
    else throw new Error(`Unknown argument: ${argument}\n${USAGE}`)
  }
  return args
}

// The overlap is shared half and half with each neighbour. The engine reads a
// context of 0 as "choose automatically", so an overlap that rounds to no
// frames is sent as the explicit no-context sentinel.
function contextFramesFor(windowFrames, overlap) {
  const frames = Math.round((windowFrames * overlap) / 2)
  return frames === 0 ? NO_CONTEXT_FRAMES : frames
}

// An explicit window becomes the engine's frame counts; without one the
// engine applies the window the model recommends (60 s / 25 % for
// TranscribePsy).
function longFormFramesFor(windowSeconds, overlap) {
  if (windowSeconds === null) return {}
  const longFormWindowFrames = Math.round(windowSeconds * ENCODER_FRAMES_PER_SECOND)
  const longFormContextFrames = contextFramesFor(longFormWindowFrames, overlap)
  return { longFormWindowFrames, longFormContextFrames }
}

// Only the full TranscribePsy-250M-EU model reads a language, so EU-sub runs
// leave the key out.
function parakeetConfigFor(args) {
  const config = longFormFramesFor(args.windowSeconds, args.overlap)
  if (args.language !== null) config.language = args.language
  return config
}

// `encoderOnCoreml` says a sidecar loaded; the two job statistics say what
// the transcription used. Both are absent when the job ran no offline
// transcription.
function describeCoremlRouting(backendInfo, stats) {
  const encoder = backendInfo.encoderOnCoreml
    ? 'Core ML'
    : backendInfo.encoderBackend || backendInfo.backendName
  const lines = [`Encoder: ${encoder}`]
  if (stats && typeof stats.encoderUsedCoreml === 'number') {
    lines.push(`Every window on Core ML: ${stats.encoderUsedCoreml === 1 ? 'yes' : 'no'}`)
  }
  if (stats && typeof stats.decoderUsedCoreml === 'number') {
    lines.push(`Decoder on Core ML: ${stats.decoderUsedCoreml === 1 ? 'yes' : 'no'}`)
  }
  return lines
}

module.exports = {
  DEFAULT_OVERLAP,
  EU_LANGUAGES,
  NO_CONTEXT_FRAMES,
  USAGE,
  describeCoremlRouting,
  longFormFramesFor,
  parakeetConfigFor,
  parseLongFormArguments
}
