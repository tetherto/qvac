/**
 * Parakeet Unified transcription from a WAV file.
 *
 * Usage:
 *   bun run examples/asr/parakeet-unified-filesystem.ts <wav-file> [parakeet-unified-gguf]
 *
 * Loads a single GGUF checkpoint (`PARAKEET_UNIFIED_0_6B_Q8_0` by default) and
 * transcribes the file with the batch `transcribe` API. The Unified RNN-T
 * checkpoint is English-only and serves both batch and low-latency streaming
 * from the same GGUF; the engine auto-detects the model type from the GGUF
 * metadata. Omit the model argument to use the registry constant.
 *
 * Audio should be 16 kHz mono PCM in a WAV container.
 */
import { loadModel, unloadModel, transcribe, PARAKEET_UNIFIED_0_6B_Q8_0 } from '@qvac/sdk'

const args = process.argv.slice(2)

if (!args[0]) {
  console.error(
    'Usage: bun run examples/asr/parakeet-unified-filesystem.ts <wav-file-path> ' +
      '[parakeet-unified-gguf]'
  )
  console.error('\nIf the model path is omitted, defaults to the registry model.')
  process.exit(1)
}

const audioFilePath = args[0]
const parakeetModelSrc = args[1] ?? PARAKEET_UNIFIED_0_6B_Q8_0

try {
  console.log('▸ Starting Parakeet Unified transcription example...')

  console.log('▸ Loading Parakeet Unified model...')
  const modelId = await loadModel({
    modelSrc: parakeetModelSrc,
    modelType: 'parakeet-transcription',
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })

  console.log(`▸ Parakeet Unified model loaded with ID: ${modelId}`)

  console.log('▸ Transcribing audio...')
  const text = await transcribe({ modelId, audioChunk: audioFilePath })

  console.log(text)

  console.log('▸ Unloading Parakeet Unified model...')
  await unloadModel({ modelId })
  console.log('▸ Parakeet Unified model unloaded successfully')
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
