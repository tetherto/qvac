import fs from 'fs'
import { loadModel, classify, unloadModel } from '@qvac/sdk'

/**
 * Classify an image using the registry MobileNetV3-Small model.
 *
 * The default model produces three classes: "food", "report", "other".
 * No modelSrc is needed — the engine downloads it from the registry.
 */
async function main() {
  const modelId = await loadModel({
    modelType: 'ggml-classification'
  })

  const image = fs.readFileSync('image.jpg')
  const results = await classify({ modelId, image })

  console.log('Classification results:')
  for (const { label, confidence } of results) {
    console.log(`  ${label}: ${(confidence * 100).toFixed(1)}%`)
  }

  await unloadModel({ modelId })
}

main().catch(console.error)
