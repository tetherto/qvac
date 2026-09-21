import { completion, loadModel, unloadModel, LLAMA_3_2_1B_INST_Q4_0 } from '@qvac/sdk'

// A catalog model loads from the registry by default. On networks where the
// registry is unreachable, pass `fallbackSrc` — an HTTP URL or a local file
// path — to load the same model from an alternate source. The bytes are
// validated against the catalog model's checksum before use.
const fallbackUrl =
  process.argv[2] ||
  'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'

console.log(`▸ Loading ${LLAMA_3_2_1B_INST_Q4_0.name} (fallback: ${fallbackUrl})`)

try {
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    fallbackSrc: fallbackUrl,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })
  console.log(`▸ Model loaded successfully! Model ID: ${modelId}`)

  const history = [{ role: 'user', content: 'Explain quantum computing in 3 key points' }]

  console.log('\n▸ AI Response:')
  const result = completion({ modelId, history, stream: true })
  for await (const token of result.tokenStream) {
    process.stdout.write(token)
  }
  console.log('\n\n▸ Completed!')

  await unloadModel({ modelId, clearStorage: false })
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
