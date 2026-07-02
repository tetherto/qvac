// Image classification. The model ships inside @qvac/classification-ggml, so no
// modelSrc is needed.
//
// Run: bare examples/classify.ts <image-file>
// Requires: npm install @qvac/core @qvac/classification-ggml

import fs from 'bare-fs'
import { registerPlugin, loadModel, classify, unloadModel } from '@qvac/core'
import { classificationPlugin } from '@qvac/core/ggml-classification/plugin'

registerPlugin(classificationPlugin)

const imagePath = Bare.argv.slice(2)[0]
if (!imagePath) {
  console.error('Usage: bare examples/classify.ts <image-file>')
} else {
  try {
    const modelId = await loadModel({ modelType: 'ggml-classification' })
    console.log(`▸ Model loaded: ${modelId}`)

    const image = fs.readFileSync(imagePath) as Buffer
    const results = await classify({ modelId, image })
    for (const { label, confidence } of results) {
      console.log(`▸ ${label}: ${(confidence * 100).toFixed(1)}%`)
    }

    await unloadModel({ modelId, autoClose: true })
  } catch (error) {
    console.error('✖', error)
  }
}
