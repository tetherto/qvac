import {
  completion,
  loadModel,
  SMOLVLM2_500M_MULTIMODAL_Q8_0,
  MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
  unloadModel,
  type HistoryContentPart
} from '@qvac/sdk'

if (process.argv.length < 3) {
  console.error(
    `▸ Specify an image file path as the first argument and a second image file path as the second (optional) argument`
  )
  process.exit(1)
}

try {
  const imageFilePath = process.argv[2]!

  // Load the main model with projection in a single step
  const modelId = await loadModel({
    modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
    modelConfig: {
      // Each image takes hundreds of context tokens, and the comparison below
      // sends two at once.
      ctx_size: 8192,
      projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0
    },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })

  // A user turn passes text and media as ordered parts.
  const history = [
    {
      role: 'user',
      content: [
        { type: 'media', path: imageFilePath },
        { type: 'text', text: "What's in this image?" }
      ] satisfies HistoryContentPart[]
    }
  ]
  const result = completion({ modelId, history, stream: true })

  for await (const token of result.tokenStream) {
    process.stdout.write(token)
  }

  const stats = await result.stats

  console.log('\n▸ Performance Stats:', stats)

  console.log('▸ --------------------------------')

  if (process.argv.length < 4) {
    console.log(`▸ Only one image provided, terminating`)
    process.exit(0)
  }

  const imageFilePath2 = process.argv[3]!

  // Each image keeps its position in the turn, so the text can name the
  // picture next to it.
  const content: HistoryContentPart[] = [
    { type: 'text', text: 'Image A: ' },
    { type: 'media', path: imageFilePath },
    { type: 'text', text: '\nImage B: ' },
    { type: 'media', path: imageFilePath2 },
    { type: 'text', text: '\nWhich image is a newspaper?' }
  ]
  const history2 = [{ role: 'user', content }]

  const result2 = completion({ modelId, history: history2, stream: true })

  for await (const token of result2.tokenStream) {
    process.stdout.write(token)
  }

  const stats2 = await result2.stats

  console.log('\n▸ Performance Stats:', stats2)

  console.log('▸ --------------------------------')

  await unloadModel({ modelId, clearStorage: false })
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
