import { writeFileSync } from 'node:fs'
import { audioGen, loadModel, unloadModel, type ModelProgressUpdate } from '@qvac/sdk'

// Usage:
//   AUDIOGEN_MINIMAX_LM_MODEL=/models/mm3-lm-q8.gguf \
//   AUDIOGEN_MINIMAX_SYNTH_MODEL=/models/mm3-synth-q8.gguf \
//   bun run examples/audiogen/generate-music-minimax.ts "warm cinematic piano" output.wav
const caption = process.argv[2] ?? 'Warm cinematic piano with gentle strings'
const outputPath = process.argv[3] ?? 'minimax-music3-output.wav'

let modelId: string | undefined

try {
  console.log('▸ Loading MiniMax-Music3 models...')
  modelId = await loadModel({
    modelType: 'audiogen',
    modelConfig: {
      engine: 'minimax',
      lmModelSrc: requiredModelPath('AUDIOGEN_MINIMAX_LM_MODEL'),
      synthModelSrc: requiredModelPath('AUDIOGEN_MINIMAX_SYNTH_MODEL'),
      useGPU: process.env['AUDIOGEN_USE_GPU'] === '1',
      threads: numberFromEnv('AUDIOGEN_THREADS')
    },
    onProgress: function (progress: ModelProgressUpdate) {
      logDownloadProgress(progress)
    }
  })

  console.log(`▸ Model loaded: ${modelId}`)
  console.log(`▸ Generating: ${caption}`)
  const run = audioGen({
    modelId,
    caption,
    lyrics: process.env['AUDIOGEN_LYRICS'] ?? '[Instrumental]',
    maxFrames: numberFromEnv('AUDIOGEN_MAX_FRAMES') ?? 250,
    seed: numberFromEnv('AUDIOGEN_SEED') ?? 7,
    inferenceSteps: numberFromEnv('AUDIOGEN_STEPS') ?? 12,
    cfgScale: numberFromEnv('AUDIOGEN_CFG_SCALE') ?? 1.7
  })

  console.log(`▸ requestId: ${run.requestId}`)
  for await (const progress of run.progressStream) {
    console.log(`▸ ${progress.stage}: ${progress.step}/${progress.total}`)
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

function requiredModelPath(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function numberFromEnv(name: string) {
  const value = process.env[name]
  return value ? Number(value) : undefined
}

function logDownloadProgress(progress: ModelProgressUpdate) {
  const downloadedMb = (progress.downloaded / 1e6).toFixed(1)
  const totalMb = (progress.total / 1e6).toFixed(1)
  const line = `▸ Downloading ${progress.percentage.toFixed(0)}% (${downloadedMb}/${totalMb} MB)`
  process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
  if (process.stderr.isTTY && progress.percentage >= 100) process.stderr.write('\n')
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
