'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const { QVACRegistryClient } = require('@qvac/registry-client')

const DEFAULT_DISK_PATH = './models/ocr'

const OCR_MODELS = {
  detector: {
    path: 'qvac_models_compiled/ocr/2026-02-12/rec_512/detector_craft.onnx',
    source: 's3',
    filename: 'detector_craft.onnx'
  },
  recognizer_latin: {
    path: 'qvac_models_compiled/ocr/2026-02-12/rec_dyn/recognizer_latin.onnx',
    source: 's3',
    filename: 'recognizer_latin.onnx'
  }
}

async function ensureModels (diskPath) {
  diskPath = diskPath || DEFAULT_DISK_PATH

  const detectorPath = path.join(diskPath, OCR_MODELS.detector.filename)
  const recognizerPath = path.join(diskPath, OCR_MODELS.recognizer_latin.filename)

  // Check if models already exist
  if (fs.existsSync(detectorPath) && fs.existsSync(recognizerPath)) {
    console.log('Models already cached locally.')
    return { detectorPath, recognizerPath }
  }

  fs.mkdirSync(diskPath, { recursive: true })

  console.log('Downloading OCR models from registry...')
  const client = new QVACRegistryClient()

  try {
    await client.ready()

    if (!fs.existsSync(detectorPath)) {
      console.log(`  Downloading ${OCR_MODELS.detector.filename}...`)
      await client.downloadModel(OCR_MODELS.detector.path, OCR_MODELS.detector.source, {
        outputFile: detectorPath,
        timeout: 60000
      })
      console.log(`  Downloaded: ${OCR_MODELS.detector.filename}`)
    }

    if (!fs.existsSync(recognizerPath)) {
      console.log(`  Downloading ${OCR_MODELS.recognizer_latin.filename}...`)
      await client.downloadModel(OCR_MODELS.recognizer_latin.path, OCR_MODELS.recognizer_latin.source, {
        outputFile: recognizerPath,
        timeout: 60000
      })
      console.log(`  Downloaded: ${OCR_MODELS.recognizer_latin.filename}`)
    }

    console.log('Models ready.')
  } finally {
    await client.close()
  }

  return { detectorPath, recognizerPath }
}

module.exports = { ensureModels, OCR_MODELS, DEFAULT_DISK_PATH }
