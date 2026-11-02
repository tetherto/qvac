'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const ImageClassifier = require('..')

async function main() {
  const imagePath = path.join(__dirname, '..', 'test', 'images', 'meal_1.jpg')
  const image = fs.readFileSync(imagePath)
  const modelPath = path.join(__dirname, '..', 'weights', 'mobilenetv3_3class_v3_fp16.gguf')
  const classifier = new ImageClassifier({ modelPath })

  try {
    await classifier.load()
    const results = await classifier.classify(image, { topK: 3 })
    console.log(JSON.stringify(results, null, 2))
  } finally {
    await classifier.unload()
  }
}

main().catch((err) => {
  console.error(err)
  if (global.Bare) global.Bare.exit(1)
  process.exit(1)
})
