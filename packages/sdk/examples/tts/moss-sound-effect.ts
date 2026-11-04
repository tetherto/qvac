import { writeFileSync } from 'node:fs'
import {
  loadModel,
  textToSpeech,
  unloadModel,
  close,
  AUDIOGEN_MOSS_SFX_V2_Q8_0,
  type ModelProgressUpdate
} from '@qvac/sdk'

// Desktop MOSS-SoundEffect-v2, 48 kHz mono output. A GPU is recommended.
// Run from packages/sdk: node --import tsx examples/tts/moss-sound-effect.ts
// Optional: QVAC_MOSS_SFX_MODEL=/absolute/path/moss-sfx-v2-q8_0.gguf
// Use the catalog source URL: its full descriptor selects the audiogen plugin.
// Each clip denoises a 30-second latent, regardless of its requested output duration.
// Use 20 steps for a practical demo; omitting steps uses the slower baked default (100).

function saveWav(samples: number[], sampleRate: number, filename: string) {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error('The model returned no usable audio.')
  }
  const wav = Buffer.alloc(44 + samples.length * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]!))), 44 + i * 2)
  }
  writeFileSync(filename, wav)
  console.error(
    `▸ Saved ${filename}: ${sampleRate} Hz, ${(samples.length / sampleRate).toFixed(2)} seconds`
  )
}

let lastPercentage = -1
function progress(p: ModelProgressUpdate) {
  const percentage = Math.floor(p.percentage)
  if (percentage === lastPercentage) return
  lastPercentage = percentage
  const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${(p.downloaded / 1e6).toFixed(1)}/${(p.total / 1e6).toFixed(1)} MB)`
  process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
  if (p.percentage >= 100) process.stderr.write('\n')
}

async function main() {
  const modelId = await loadModel({
    modelSrc: process.env['QVAC_MOSS_SFX_MODEL'] ?? AUDIOGEN_MOSS_SFX_V2_Q8_0.src,
    modelType: 'tts-ggml',
    modelConfig: { ttsEngine: 'moss-sfx', useGPU: true, seed: 42 },
    onProgress: progress
  })
  try {
    console.error('▸ Generating a sound effect...')
    const result = textToSpeech({
      modelId,
      text: 'Heavy rain falling on a tin roof.',
      stream: false,
      seconds: 2,
      steps: 20
    })
    const samples = await result.buffer
    if (!(await result.done)) throw new Error('Sound-effect generation did not complete.')
    const sampleRate = await result.sampleRate
    if (sampleRate !== 48000) throw new Error(`Unexpected sound-effect sample rate: ${sampleRate}`)
    saveWav(samples, sampleRate, 'moss-sound-effect-output.wav')
  } finally {
    await unloadModel({ modelId })
  }
}

try {
  await main()
} catch (error) {
  console.error('✖', error)
  process.exitCode = 1
} finally {
  try {
    await close()
  } catch (error) {
    console.error('✖ Cleanup failed:', error)
    process.exitCode = 1
  }
}
