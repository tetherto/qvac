/**
 * Assess MOSS memory before downloading weights or loading a model.
 * Run from packages/sdk:
 *   node --import tsx examples/asr/moss-transcribe-fit.ts <audio-seconds> [moss.gguf] [hotword ...]
 * Without a local path, uses the Q8_0 registry model's weightless description.
 */
import { assessModelFit, close, MOSS_TRANSCRIBE_DIARIZE_Q8_0 } from '@qvac/sdk'

const [seconds, modelPath, ...hotwords] = process.argv.slice(2)
const audioSeconds = Number(seconds)
if (seconds === '--help' || !Number.isFinite(audioSeconds) || audioSeconds <= 0) {
  console.error(
    'Usage: node --import tsx examples/asr/moss-transcribe-fit.ts <audio-seconds> [moss.gguf] [hotword ...]'
  )
  process.exit(seconds === '--help' ? 0 : 1)
}
try {
  console.error('▸ Assessing MOSS memory for the declared recording...')
  const result = await assessModelFit({
    models: [
      {
        modelType: 'moss-transcribe',
        modelSrc: modelPath ?? MOSS_TRANSCRIBE_DIARIZE_Q8_0,
        modelConfig: { useGPU: false, maxThreads: 4 },
        transcriptionWorkload: { audioSeconds, hotwords, maxNewTokens: 0 }
      }
    ]
  })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error('✖ MOSS memory assessment failed:', error)
  process.exitCode = 1
} finally {
  try {
    await close()
  } catch (error) {
    console.error('✖ Could not close the SDK:', error)
    process.exitCode = 1
  }
}
