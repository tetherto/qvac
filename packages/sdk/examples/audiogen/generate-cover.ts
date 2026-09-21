import { writeFileSync } from 'node:fs'
import {
  AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
  AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
  AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
  AUDIOGEN_VAE_BF16,
  audioGen,
  loadModel,
  unloadModel
} from '@qvac/sdk'

// Re-render an existing song with a new caption (ACE-Step "cover-nofsq"),
// optionally conditioning the timbre on a second reference clip.
//
// Usage:
//   bun examples/audiogen/generate-cover.ts <source.wav|mp3|...> "orchestral arrangement" [reference.wav] [output.wav]
//
// Both audio inputs are file paths: the SDK decodes them (any FFmpeg-decodable
// format) to the 48 kHz stereo float PCM the engine expects. Pass raw
// interleaved stereo 48 kHz Float32 LE PCM as a Buffer instead when the audio
// is already in memory.
const sourcePath = process.argv[2]
const caption = process.argv[3] ?? 'Orchestral arrangement with dramatic strings'
const referencePath = process.argv[4]
const outputPath = process.argv[5] ?? 'audiogen-cover.wav'

if (!sourcePath) {
  console.error(
    'Usage: bun examples/audiogen/generate-cover.ts <source-audio> "<caption>" [reference-audio] [output.wav]'
  )
  process.exit(1)
}

let modelId: string | undefined

try {
  console.log('▸ Loading ACE-Step AudioGen models...')
  modelId = await loadModel({
    modelType: 'audiogen',
    modelConfig: {
      textEncModelSrc: AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
      lmModelSrc: AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
      ditModelSrc: AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
      vaeModelSrc: AUDIOGEN_VAE_BF16,
      useGPU: true
    }
  })
  console.log(`▸ Model loaded: ${modelId}`)
  console.log(`▸ Covering ${sourcePath} as: ${caption}`)

  const run = audioGen({
    modelId,
    caption,
    lyrics: '[Instrumental]',
    taskType: 'cover-nofsq',
    sourceAudio: sourcePath,
    ...(referencePath !== undefined && { referenceAudio: referencePath }),
    // cover-nofsq keeps the full source context; coverNoiseStrength blends the
    // initial noise toward the source latent (0 = pure noise, 1 ≈ source).
    audioCoverStrength: 1,
    coverNoiseStrength: 0.75,
    seed: 22886
  })
  console.log(`▸ requestId: ${run.requestId}`)

  for await (const progress of run.progressStream) {
    const value =
      progress.total > 0 ? `${progress.step}/${progress.total}` : `${progress.step} (indeterminate)`
    console.log(`▸ ${progress.stage}: ${value}`)
  }

  const [audio, stats] = await Promise.all([run.audio, run.stats])
  writeFileSync(
    outputPath,
    createWav(audio.pcm, audio.sampleRate, audio.channels, audio.bitsPerSample)
  )
  if (stats) console.log(`▸ Stats: ${JSON.stringify(stats)}`)
  console.log(`▸ Saved ${outputPath}`)

  await unloadModel({ modelId })
  modelId = undefined
  process.exit(0)
} catch (error) {
  if (modelId !== undefined) {
    try {
      await unloadModel({ modelId })
    } catch {
      // Preserve the generation error as the primary failure.
    }
  }
  console.error('✖', error)
  process.exit(1)
}

function createWav(pcm: Uint8Array, sampleRate: number, channels: number, bitsPerSample: number) {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const blockAlign = channels * (bitsPerSample / 8)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, pcm.byteLength, true)

  const wav = new Uint8Array(44 + pcm.byteLength)
  wav.set(new Uint8Array(header))
  wav.set(pcm, 44)
  return wav
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}
