/**
 * TranscribePsy transcription from an audio file.
 *
 * Usage:
 *   npx tsx examples/asr/parakeet-transcribepsy-filesystem.ts <audio-file> [--coreml] [--window-sec <seconds>]
 *
 * TranscribePsy-250M-EU-sub is a 254M Parakeet-TDT distilled for Dutch,
 * English, French, German, Italian, Polish, Portuguese and Spanish; the engine
 * detects the language, so there is nothing to set. The default constant
 * (`PARAKEET_TRANSCRIBEPSY_250M_Q8_0`) runs on ggml everywhere. On
 * macOS and iOS, `--coreml` loads the Core ML distribution instead
 * (`PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0`): the SDK downloads its
 * encoder and decoder bundles with the GGUF, and both stages run on the Neural
 * Engine. Anywhere else that constant is refused at load time.
 *
 * Long recordings are encoded in overlapping windows, so memory stays flat
 * however long the file is. Without `--window-sec` the engine uses the 60 s
 * windows with 25 % overlap the model recommends; an explicit window is sent
 * as encoder frames (12.5 per second) with a quarter of it as context, which
 * is how a phone with little memory can trade speed for a smaller footprint.
 */
import {
  loadModel,
  unloadModel,
  transcribe,
  PARAKEET_TRANSCRIBEPSY_250M_Q8_0,
  PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0
} from '@qvac/sdk'

const ENCODER_FRAMES_PER_SECOND = 12.5
const RECOMMENDED_OVERLAP = 0.25

const args = process.argv.slice(2)
const audioFilePath = args.find((arg) => !arg.startsWith('--'))
const useCoreml = args.includes('--coreml')
const windowIndex = args.indexOf('--window-sec')
const windowSeconds = windowIndex === -1 ? undefined : Number(args[windowIndex + 1])

if (!audioFilePath || (windowSeconds !== undefined && !(windowSeconds > 0))) {
  console.error(
    'Usage: npx tsx examples/asr/parakeet-transcribepsy-filesystem.ts <audio-file> ' +
      '[--coreml] [--window-sec <seconds>]'
  )
  process.exit(1)
}

// An explicit window becomes the engine's frame counts; the overlap is shared
// half and half with each neighbouring window.
const longForm =
  windowSeconds === undefined
    ? {}
    : {
        longFormWindowFrames: Math.round(windowSeconds * ENCODER_FRAMES_PER_SECOND),
        longFormContextFrames: Math.round(
          (windowSeconds * ENCODER_FRAMES_PER_SECOND * RECOMMENDED_OVERLAP) / 2
        )
      }

const modelSrc = useCoreml
  ? PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0
  : PARAKEET_TRANSCRIBEPSY_250M_Q8_0

try {
  console.log(`▸ Loading TranscribePsy (${useCoreml ? 'Core ML distribution' : 'ggml'})...`)
  const modelId = await loadModel({
    modelSrc,
    modelType: 'parakeet-transcription',
    modelConfig: longForm,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })

  console.log(
    windowSeconds === undefined
      ? '▸ Transcribing with the windows the model recommends (60 s, 25 % overlap)...'
      : `▸ Transcribing in ${windowSeconds} s windows...`
  )
  const call = transcribe({ modelId, audioChunk: audioFilePath })
  const text = await call
  const stats = await call.stats

  console.log(text)
  if (stats) {
    console.log(
      `▸ ${stats.audioDuration?.toFixed(1) ?? '?'} s of audio, real-time factor ${stats.realTimeFactor?.toFixed(3) ?? '?'}` +
        (useCoreml ? `, encoder on Core ML: ${stats.encoderUsedCoreml === 1 ? 'yes' : 'no'}` : '')
    )
  }

  await unloadModel({ modelId })
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
