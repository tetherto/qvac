import fs from 'fs'
import { loadModel, classify, unloadModel } from '@qvac/sdk'

/**
 * Classify an image using the bundled MobileNetV3-Small model.
 *
 * The bundled model produces three classes: "food", "report", "other".
 * No modelSrc is needed — the model ships inside @qvac/classification-ggml.
 *
 * Usage: npx tsx examples/classification/classify-image.ts <image-path>
 */
async function main() {
  const imagePath = process.argv[2]
  if (!imagePath) {
    console.error('Usage: npx tsx examples/classification/classify-image.ts <image-path>')
    process.exit(1)
  }

  const modelId = await loadModel({
    modelType: 'ggml-classification'
  })

  const image = fs.readFileSync(imagePath)
  const results = await classify({ modelId, image })

  console.log('Classification results:')
  for (const { label, confidence } of results) {
    console.log(`  ${label}: ${(confidence * 100).toFixed(1)}%`)
  }

  await unloadModel({ modelId })
}

main().catch(console.error)
