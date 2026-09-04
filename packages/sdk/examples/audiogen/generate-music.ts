import { writeFileSync } from 'node:fs'
import {
  AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
  AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
  AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
  AUDIOGEN_VAE_BF16,
  audioGen,
  loadModel,
  unloadModel,
  type ModelProgressUpdate
} from '@qvac/sdk'

// Usage:
//   bun examples/audiogen/generate-music.ts "lo-fi hip hop, mellow piano" output.wav
const caption =
  process.argv[2] ?? 'Lo-fi hip hop with mellow piano, soft drums, and a warm bass line'
const outputPath = process.argv[3] ?? 'audiogen-output.wav'

let modelId: string | undefined
const lastLoggedPercentageByDownload = new Map<string, number>()
const completedDownloads = new Set<string>()

try {
  console.log('▸ Loading ACE-Step AudioGen models...')
  modelId = await loadModel({
    modelType: 'audiogen',
    modelConfig: {
      textEncModelSrc: AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
      lmModelSrc: AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
      ditModelSrc: AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
      vaeModelSrc: AUDIOGEN_VAE_BF16,
      useGPU: true,
      inferenceSteps: 8
    },
    onProgress: (progress: ModelProgressUpdate) => {
      const mb = (bytes: number) => (bytes / 1e6).toFixed(1)
      const label = getDownloadLabel(progress.downloadKey)
      const line =
        `▸ Downloading ${label}: ${progress.percentage.toFixed(0)}% ` +
        `(${mb(progress.downloaded)}/${mb(progress.total)} MB)`

      if (process.stderr.isTTY) {
        process.stderr.write(`\r${line}`)
        if (progress.percentage >= 100 && !completedDownloads.has(progress.downloadKey)) {
          completedDownloads.add(progress.downloadKey)
          process.stderr.write('\n')
        }
        return
      }

      const percentageBucket = Math.floor(progress.percentage / 5) * 5
      const lastLogged = lastLoggedPercentageByDownload.get(progress.downloadKey)
      const isNewCompletion = progress.percentage >= 100 && lastLogged !== 100
      if (lastLogged === undefined || percentageBucket > lastLogged || isNewCompletion) {
        lastLoggedPercentageByDownload.set(progress.downloadKey, percentageBucket)
        process.stderr.write(`${line}\n`)
      }
    }
  })

  console.log(`▸ Model loaded: ${modelId}`)
  console.log(`▸ Generating: ${caption}`)

  const run = audioGen({
    modelId,
    caption,
    lyrics: '[Instrumental]',
    seed: 42,
    duration: 10
  })
  console.log(`▸ requestId: ${run.requestId}`)

  for await (const progress of run.progressStream) {
    const value =
      progress.total > 0 ? `${progress.step}/${progress.total}` : `${progress.step} (indeterminate)`
    console.log(`▸ ${progress.stage}: ${value}`)
  }

  const [audio, stats] = await Promise.all([run.audio, run.stats])
  const wav = createWav(audio.pcm, audio.sampleRate, audio.channels, audio.bitsPerSample)
  writeFileSync(outputPath, wav)

  const samplesPerChannel = audio.pcm.byteLength / (audio.bitsPerSample / 8) / audio.channels
  console.log(
    `▸ Generated ${samplesPerChannel} samples per channel at ` +
      `${audio.sampleRate} Hz (${audio.channels} channels)`
  )
  if (stats) console.log(`▸ Stats: ${JSON.stringify(stats)}`)
  console.log(`▸ Saved ${outputPath}`)

  await unloadModel({ modelId })
  modelId = undefined
  console.log('▸ Model unloaded')
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

function getDownloadLabel(downloadKey: string) {
  return downloadKey.split('/').pop() ?? downloadKey
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
