import { loadModel, translate, unloadModel, BERGAMOT_EN_FR } from '@qvac/sdk'

try {
  const modelId = await loadModel({
    modelSrc: BERGAMOT_EN_FR,
    modelConfig: {
      engine: 'Bergamot',
      from: 'en',
      to: 'fr'
    },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })

  console.log(`▸ Bergamot model loaded: ${modelId}`)

  const texts = [
    'Hello world',
    'How are you today?',
    'This is a test of batch translation',
    'The weather is nice'
  ]

  console.log('▸ Streaming a batch, one translation per token:')

  const result = translate({
    modelId,
    text: texts,
    modelType: 'nmtcpp-translation',
    stream: true
  })

  let index = 0
  for await (const translation of result.tokenStream) {
    console.log(`  ${index + 1}. ${texts[index]} -> "${translation}"`)
    index++
  }

  console.log(`▸ Translated ${index} texts`)

  await unloadModel({ modelId })
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
