import { close, loadModel, textToSpeech, unloadModel } from '@qvac/sdk'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Run with a local GGUF and matching -decoder.mlmodelc / -dac.mlmodelc bundles
// beside it. Requires a Core ML-enabled addon and macOS 15 / iOS 18 for decoder
// steps. The model registry does not currently distribute these bundles.
const modelPath = process.argv[2]
if (!modelPath) {
  console.error('✖ Usage: tsx parler-coreml.ts /path/to/parler-mini-v1-q8_0.gguf')
  process.exit(1)
}

let modelId: string | undefined
try {
  modelId = await loadModel({
    modelSrc: resolve(modelPath),
    modelType: 'tts-ggml',
    modelConfig: {
      ttsEngine: 'parler',
      coremlDecoder: true,
      coremlComputeUnits: 'cpu_and_ane',
      coremlStrict: true,
      useGPU: false,
      threads: 4,
      seed: 42,
      maxFrames: 450,
      voice: 'Laura'
    }
  })
  console.log('▸ Parler loaded with strict CPU+ANE policy')
  const result = textToSpeech({
    modelId,
    text: 'Hello. This speech was generated locally.',
    stream: false
  })
  const samples = await result.buffer
  const sampleRate = await result.sampleRate
  const stats = await result.stats
  if (!sampleRate || !samples.length || stats?.decoderOnCoreml !== 1 || stats.dacOnCoreml !== 1) {
    throw new Error('Synthesis did not report completed Core ML decoder and DAC execution')
  }

  // Mono signed 16-bit little-endian WAV. Keep the example self-contained.
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
  for (let index = 0; index < samples.length; index++) {
    wav.writeInt16LE(samples[index]!, 44 + index * 2)
  }
  await writeFile('parler-coreml.wav', wav)
  console.log(`▸ Saved ${samples.length} samples at ${sampleRate} Hz to parler-coreml.wav`)
  console.log('▸ Execution stats:', stats)
} catch (error) {
  console.error('✖', error)
  process.exitCode = 1
} finally {
  try {
    if (modelId) await unloadModel({ modelId })
  } finally {
    await close()
  }
}
