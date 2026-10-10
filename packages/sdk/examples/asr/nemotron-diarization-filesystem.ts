/**
 * Nemotron 3 Diarization detects up to eight speakers, including overlapping turns.
 * It reports speaker activity, not recognized words.
 *
 * Run from packages/sdk with a local Nemotron 3 Diarization GGUF:
 *   bun run examples/asr/nemotron-diarization-filesystem.ts <nemotron-diarization.gguf> [audio.wav]
 *
 * Defaults to examples/audio/diarization-sample-16k.wav in the source repository.
 * Supply a 16 kHz mono PCM WAV when copying this example elsewhere.
 */
import { access, constants } from 'node:fs/promises'
import { loadModel, unloadModel, transcribe, close } from '@qvac/sdk'

const [modelPath, audioPath = 'examples/audio/diarization-sample-16k.wav'] = process.argv.slice(2)
if (!modelPath || modelPath === '--help') {
  console.error(
    'Usage: bun run examples/asr/nemotron-diarization-filesystem.ts <nemotron-diarization.gguf> [audio.wav]'
  )
  process.exit(modelPath === '--help' ? 0 : 1)
}

let modelId: string | undefined
try {
  await access(modelPath, constants.R_OK)
  await access(audioPath, constants.R_OK)
  console.error('▸ Loading Nemotron 3 Diarization through the Parakeet engine...')
  modelId = await loadModel({
    modelSrc: modelPath,
    modelType: 'parakeet-transcription',
    modelConfig: {
      maxThreads: 4,
      useGPU: false
      // Optional: diarizationThreshold and diarizationMinSegmentMs.
      // Omit them to use the loaded model's defaults.
    }
  })
  console.error(`▸ Diarizing ${audioPath}...`)
  const segments = await transcribe({ modelId, audioChunk: audioPath, metadata: true })
  const turns = segments.flatMap((segment) => segment.speakerSegments ?? [])
  for (const turn of turns) {
    console.log(
      `[${(turn.startMs / 1000).toFixed(2)}s → ${(turn.endMs / 1000).toFixed(2)}s] Speaker ${turn.speakerId + 1}`
    )
  }
  if (turns.length === 0) console.error('▸ No speaker turns returned.')
} catch (error) {
  console.error('✖ Nemotron diarization failed:', error)
  process.exitCode = 1
} finally {
  try {
    if (modelId !== undefined) await unloadModel({ modelId })
  } catch (error) {
    console.error('✖ Could not unload the diarization model:', error)
    process.exitCode = 1
  } finally {
    try {
      await close()
    } catch (error) {
      console.error('✖ Could not close the SDK:', error)
      process.exitCode = 1
    }
  }
}
