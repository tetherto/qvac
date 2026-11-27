/**
 * Whisper transcription with prompt example.
 *
 * Usage:
 *   npx tsx examples/asr/whispercpp-prompt.ts <wav-file>
 *
 * Pass the path of a 16 kHz mono WAV file. A sample is available in the QVAC
 * source repository, but not included in the published npm package:
 *   https://github.com/tetherto/qvac/blob/main/packages/sdk/examples/audio/sample-16khz.wav
 */
import { loadModel, unloadModel, transcribe, WHISPER_TINY } from '@qvac/sdk'

const audioFilePath = process.argv[2]

if (!audioFilePath) {
  console.error('Usage: npx tsx examples/asr/whispercpp-prompt.ts <wav-file>')
  process.exit(1)
}

try {
  console.log('▸ Starting Whisper transcription with prompt example...')

  // Load the Whisper model
  console.log('▸ Loading Whisper model...')
  const modelId = await loadModel({
    modelSrc: WHISPER_TINY,
    modelConfig: {
      audioFormat: 'f32le',
      // Sampling strategy
      strategy: 'greedy',
      threads: 4,
      // Transcription options
      language: 'en',
      translate: false,
      noTimestamps: false,
      singleSegment: false,
      printTimestamps: true,
      tokenTimestamps: true,
      // Quality settings
      temperature: 0.0,
      suppressBlank: true,
      suppressNst: true,
      // Advanced tuning
      entropyThold: 2.4,
      logprobThold: -1.0,
      // VAD configuration
      vadParams: {
        threshold: 0.35,
        minSpeechDurationMs: 200,
        minSilenceDurationMs: 150,
        maxSpeechDurationS: 30.0,
        speechPadMs: 600,
        samplesOverlap: 0.3
      },
      // Context parameters for GPU
      contextParams: {
        useGpu: true,
        flashAttention: true,
        gpuDevice: 0
      }
    },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })

  console.log(`▸ Whisper model loaded with ID: ${modelId}`)

  // Perform transcription
  console.log('▸ Transcribing audio...')
  const text = await transcribe({
    modelId,
    audioChunk: audioFilePath,
    prompt: 'This is a test recording with clear speech and proper punctuation.'
  })

  console.log('▸ Transcription result:')
  console.log(text)

  // Unload the model when done
  console.log('▸ Unloading Whisper model...')
  await unloadModel({ modelId })
  console.log('▸ Whisper model unloaded successfully')
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
