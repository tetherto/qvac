import { writeFileSync } from 'node:fs'
import {
  AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
  AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
  AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
  AUDIOGEN_VAE_BF16,
  audioEdit,
  loadModel,
  unloadModel
} from '@qvac/sdk'

// Edit an existing recording with ACE-Step: a Flow-Edit that re-conditions the
// whole clip from a source prompt to a target prompt, then a Repaint that
// regenerates one time range against a new prompt. Operations run in order.
//
// Usage:
//   bun examples/audiogen/edit-music.ts <source.wav|mp3|...> "original pop song" "guitar pop-rock" [output.wav]
//
// The source is a file path: the SDK decodes it (any FFmpeg-decodable format)
// to the 48 kHz stereo float PCM the engine expects. Pass raw interleaved
// stereo 48 kHz Float32 LE PCM in [-1, 1] as a Buffer instead when the audio
// is already in memory — for example the `pcm` of an earlier `audioGen()` run,
// converted from Int16 to Float32.
const sourcePath = process.argv[2]
const fromCaption = process.argv[3] ?? 'Original pop song'
const toCaption = process.argv[4] ?? 'Guitar pop-rock'
const outputPath = process.argv[5] ?? 'audiogen-edit.wav'

if (!sourcePath) {
  console.error(
    'Usage: bun examples/audiogen/edit-music.ts <source-audio> "<from caption>" "<to caption>" [output.wav]'
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
      // Flow-Edit needs a turbo DiT variant; Repaint works on every variant.
      ditModelSrc: AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
      vaeModelSrc: AUDIOGEN_VAE_BF16,
      useGPU: true
    }
  })
  console.log(`▸ Model loaded: ${modelId}`)
  console.log(`▸ Editing ${sourcePath}: "${fromCaption}" -> "${toCaption}"`)

  const run = audioEdit({
    modelId,
    sourceAudio: sourcePath,
    operations: [
      {
        type: 'flow-edit',
        from: { caption: fromCaption },
        to: { caption: toCaption }
      },
      {
        // Regenerate seconds 10-20 as a synth solo; the rest of the clip is kept.
        type: 'repaint',
        caption: 'analog synth solo',
        lyrics: '[Instrumental]',
        start: 10,
        end: 20,
        mode: 'balanced',
        strength: 0.5
      }
    ],
    // Seeds the first operation; each following operation uses seed + index.
    seed: 22883
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
      // Preserve the edit error as the primary failure.
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
