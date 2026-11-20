import { translate, loadModel, unloadModel, AFRICAN_4B_TRANSLATION_Q4_K_M } from '@qvac/sdk'

try {
  const modelId = await loadModel({
    modelSrc: AFRICAN_4B_TRANSLATION_Q4_K_M,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    },
    // IMPORTANT: these parameters are validated to be optimal
    modelConfig: {
      tools: true,
      ctxSize: 2048,
      topK: 1,
      topP: 1,
      temperature: 0,
      repeatPenalty: 1,
      seed: 42,
      predict: 256,
      stopSequences: ['\n']
    }
  })

  // With explicit source language
  const engText = 'Hello, how are you today?'
  const resultExplicit = translate({
    modelId,
    text: engText,
    from: 'en',
    to: 'swh_Latn',
    modelType: 'llamacpp-completion',
    stream: false
  })

  const translatedTextExplicit = await resultExplicit.text

  console.log(`Explicit source: ${engText} -> "${translatedTextExplicit}"`)

  await unloadModel({ modelId, clearStorage: false })
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
