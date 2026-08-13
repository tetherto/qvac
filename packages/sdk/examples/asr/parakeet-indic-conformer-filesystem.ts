/**
 * Indic Conformer CTC transcription from a WAV file.
 *
 * Usage:
 *   bun run examples/asr/parakeet-indic-conformer-filesystem.ts <wav-file> <language> [gguf]
 *
 * Loads a single GGUF checkpoint (`PARAKEET_INDIC_CONFORMER_CTC_Q8_0` by
 * default) and transcribes with the batch `transcribe` API. `language` is
 * required (e.g. `hi`, `ta`) because Indic Conformer CTC masks the vocab
 * with `parakeet.ctc.lang_*` ranges. English Parakeet CTC ignores this field.
 *
 * Audio should be 16 kHz mono PCM in a WAV container.
 */
import { loadModel, unloadModel, transcribe, PARAKEET_INDIC_CONFORMER_CTC_Q8_0 } from '@qvac/sdk'

const args = process.argv.slice(2)

if (!args[0] || !args[1]) {
  console.error(
    'Usage: bun run examples/asr/parakeet-indic-conformer-filesystem.ts ' +
      '<wav-file> <language> [indic-conformer-gguf]'
  )
  console.error('\nExample: ... filesystem.ts speech.wav hi')
  console.error('If the model path is omitted, defaults to the registry model.')
  process.exit(1)
}

const audioFilePath = args[0]
const language = args[1]
const parakeetModelSrc = args[2] ?? PARAKEET_INDIC_CONFORMER_CTC_Q8_0

try {
  console.log('▸ Loading Indic Conformer CTC model...')
  const modelId = await loadModel({
    modelSrc: parakeetModelSrc,
    modelType: 'parakeet-transcription',
    modelConfig: { language },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })

  console.log(`▸ Indic Conformer CTC model loaded with ID: ${modelId}`)
  console.log(`▸ Language: ${language}`)

  console.log('▸ Transcribing audio...')
  const text = await transcribe({ modelId, audioChunk: audioFilePath })

  console.log(text)

  console.log('▸ Unloading model...')
  await unloadModel({ modelId })
  console.log('▸ Done')
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
