'use strict'

const { ONNXOcr } = require('../..')
const path = require('bare-path')
const fs = require('bare-fs')
const { getImagePath, ensureModelPath } = require('./utils')

const MODELS_DIR = path.resolve('.', 'test/models/doctr')
const DB_MOBILENET = path.join(MODELS_DIR, 'db_mobilenet_v3_large.onnx')
const CRNN_MOBILENET = path.join(MODELS_DIR, 'crnn_mobilenet_v3_small.onnx')

const imagePath = getImagePath('/test/images/lab_results.png')
const outputDir = path.resolve('.', 'test/output')

async function runOCR (params) {
  const onnxOcr = new ONNXOcr({
    params: {
      langList: ['en'],
      useGPU: false,
      ...params
    },
    opts: { stats: true }
  })

  await onnxOcr.load()

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    let results = []

    await response
      .onUpdate(output => {
        results = output.map(o => ({ bbox: o[0], text: o[1], confidence: o[2] }))
      })
      .onError(error => {
        console.error('Error:', error)
      })
      .await()

    return results
  } finally {
    try { await onnxOcr.unload() } catch (e) { /* ignore */ }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

async function main () {
  fs.mkdirSync(outputDir, { recursive: true })

  console.log('Running DocTR...')
  const doctrResults = await runOCR({
    pathDetector: DB_MOBILENET,
    pathRecognizer: CRNN_MOBILENET,
    pipelineMode: 'doctr',
    decodingMethod: 'ctc',
    straightenPages: true
  })
  console.log(`DocTR: ${doctrResults.length} regions`)

  const doctrPath = path.join(outputDir, 'lab_results_doctr.json')
  fs.writeFileSync(doctrPath, JSON.stringify(doctrResults, null, 2))
  console.log('Saved:', doctrPath)

  console.log('Running EasyOCR...')
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const easyocrResults = await runOCR({
    pathDetector: detectorPath,
    pathRecognizer: recognizerPath
  })
  console.log(`EasyOCR: ${easyocrResults.length} regions`)

  const easyocrPath = path.join(outputDir, 'lab_results_easyocr.json')
  fs.writeFileSync(easyocrPath, JSON.stringify(easyocrResults, null, 2))
  console.log('Saved:', easyocrPath)
}

main().catch(e => { console.error(e); process.exit(1) })
