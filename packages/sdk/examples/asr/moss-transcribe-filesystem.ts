/**
 * MOSS-Transcribe-Diarize: one model produces text, timestamps, and speaker labels.
 *
 * Run from packages/sdk:
 *   bun run examples/asr/moss-transcribe-filesystem.ts <audio.wav> [moss.gguf] [hotword ...]
 *   bun run examples/asr/moss-transcribe-filesystem.ts examples/audio/diarization-sample-16k.wav
 *   bun run examples/asr/moss-transcribe-filesystem.ts meeting.wav ./moss.gguf QVAC OpenMOSS
 *
 * Omit the GGUF path to download MOSS_TRANSCRIBE_DIARIZE_Q8_0 from the registry.
 * Use a 16 kHz mono PCM WAV recording. Hotwords are optional names/domain terms
 * for this request, with at most 64 terms of 64 UTF-8 bytes each.
 * This is batch transcription; MOSS streaming and CoreML are not exposed.
 */
import { access, constants } from 'node:fs/promises'
import { loadModel, unloadModel, transcribe, close, MOSS_TRANSCRIBE_DIARIZE_Q8_0 } from '@qvac/sdk'

const [audioFilePath, modelPath, ...hotwords] = process.argv.slice(2)

if (!audioFilePath || audioFilePath === '--help') {
  console.error(
    'Usage: bun run examples/asr/moss-transcribe-filesystem.ts <audio.wav> [moss.gguf] [hotword ...]'
  )
  process.exit(audioFilePath === '--help' ? 0 : 1)
}

let modelId: string | undefined

try {
  // Check the recording before starting a model download.
  await access(audioFilePath, constants.R_OK)
  console.error('▸ Loading MOSS-Transcribe-Diarize...')
  modelId = await loadModel({
    modelType: 'moss-transcribe',
    modelSrc: modelPath ?? MOSS_TRANSCRIBE_DIARIZE_Q8_0,
    modelConfig: {
      maxThreads: 4,
      useGPU: false // Set true to opt into Metal on a supported Mac.
    },
    onProgress: (progress) => {
      const mb = (bytes: number) => (bytes / 1e6).toFixed(1)
      const line = `▸ Downloading ${progress.percentage.toFixed(0)}% (${mb(progress.downloaded)}/${mb(progress.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (process.stderr.isTTY && progress.percentage >= 100) process.stderr.write('\n')
    }
  })

  console.error(`▸ Transcribing ${audioFilePath}...`)
  const segments = await transcribe({
    modelId,
    audioChunk: audioFilePath,
    metadata: true,
    hotwords,
    maxNewTokens: 0 // Use the model's default decoding limit.
    // For a custom instruction, replace hotwords with prompt; do not supply both.
  })

  for (const segment of segments) {
    const start = (segment.startMs / 1000).toFixed(2)
    const end = (segment.endMs / 1000).toFixed(2)
    const speaker =
      segment.speaker ??
      (segment.speakerId !== undefined ? `Speaker ${segment.speakerId}` : 'Unknown speaker')
    console.log(`[${start}s → ${end}s] ${speaker}: ${segment.text.trim()}`)
  }
  if (segments.length === 0) console.error('▸ No speech segments returned.')
} catch (error) {
  console.error('✖ MOSS transcription failed:', error)
  process.exitCode = 1
} finally {
  try {
    if (modelId !== undefined) {
      console.error('▸ Unloading MOSS model...')
      await unloadModel({ modelId })
    }
  } catch (error) {
    console.error('✖ Could not unload the MOSS model:', error)
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
