// Optical character recognition. Pass an image file to read text from.
//
// Run: bare examples/ocr.ts <image-file>
// Requires: npm install @qvac/core @qvac/ocr-ggml

import { registerPlugin, loadModel, ocr, unloadModel, OCR_LATIN } from '@qvac/core'
import { ocrPlugin } from '@qvac/core/ggml-ocr/plugin'

registerPlugin(ocrPlugin)

const imagePath = Bare.argv.slice(2)[0]
if (!imagePath) {
  console.error('Usage: bare examples/ocr.ts <image-file>')
} else {
  try {
    const modelId = await loadModel({
      modelSrc: OCR_LATIN,
      modelConfig: { langList: ['en'] }
    })
    console.log(`▸ Model loaded: ${modelId}`)

    const { blocks } = ocr({ modelId, image: imagePath })
    for (const block of await blocks) {
      console.log(`▸ ${block.text}`)
    }

    await unloadModel({ modelId, autoClose: true })
  } catch (error) {
    console.error('✖', error)
  }
}
