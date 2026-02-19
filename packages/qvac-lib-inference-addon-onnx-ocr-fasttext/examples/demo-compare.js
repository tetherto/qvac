'use strict'

/**
 * DocTR vs EasyOCR Demo Comparison
 *
 * Runs both pipelines on the lab_results image and outputs timing + word counts.
 * Saves result JSON files for visualization with demo-visualize.py.
 *
 * Usage: bare examples/demo-compare.js
 *
 * Prerequisites:
 *   - DocTR models in test/models/doctr/ (auto-downloaded if missing)
 *   - EasyOCR models in models/ocr/rec_dyn/
 *
 * Then visualize:
 *   python3 examples/demo-visualize.py
 */

const { ONNXOcr } = require('..')
const fs = require('bare-fs')
const path = require('bare-path')

const PKG_DIR = path.resolve('.')
const IMAGE_PATH = path.join(PKG_DIR, 'test/images/lab_results.png')
const OUTPUT_DIR = path.join(PKG_DIR, 'test/output')

// DocTR models
const DOCTR_MODELS_DIR = path.join(PKG_DIR, 'test/models/doctr')
const DB_MOBILENET = path.join(DOCTR_MODELS_DIR, 'db_mobilenet_v3_large.onnx')
const CRNN_MOBILENET = path.join(DOCTR_MODELS_DIR, 'crnn_mobilenet_v3_small.onnx')

// EasyOCR models
const EASYOCR_DETECTOR = path.join(PKG_DIR, 'models/ocr/rec_dyn/detector_craft.onnx')
const EASYOCR_RECOGNIZER = path.join(PKG_DIR, 'models/ocr/rec_dyn/recognizer_latin.onnx')

// DocTR model download URLs (from OnnxTR GitHub releases)
const DOCTR_MODEL_URLS = {
  'db_mobilenet_v3_large.onnx': 'https://github.com/felixdittrich92/OnnxTR/releases/download/v0.2.0/db_mobilenet_v3_large-4987e7bd.onnx',
  'crnn_mobilenet_v3_small.onnx': 'https://github.com/felixdittrich92/OnnxTR/releases/download/v0.0.1/crnn_mobilenet_v3_small-bded4d49.onnx'
}

async function ensureDoctrModels () {
  fs.mkdirSync(DOCTR_MODELS_DIR, { recursive: true })
  for (const [filename, url] of Object.entries(DOCTR_MODEL_URLS)) {
    const dest = path.join(DOCTR_MODELS_DIR, filename)
    if (fs.existsSync(dest)) continue
    console.log(`Downloading ${filename}...`)
    const fetch = require('bare-fetch')
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${filename}`)
    const buffer = await response.arrayBuffer()
    fs.writeFileSync(dest, Buffer.from(buffer))
    console.log(`Downloaded ${filename} (${Math.round(buffer.byteLength / 1024 / 1024)}MB)`)
  }
}

async function runOCR (label, params) {
  console.log(`\nRunning ${label}...`)

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
      path: IMAGE_PATH,
      options: { paragraph: false }
    })

    let results = []

    await response
      .onUpdate(output => {
        results = output.map(o => ({ bbox: o[0], text: o[1], confidence: o[2] }))
      })
      .onError(error => {
        console.error(`${label} error:`, error)
      })
      .await()

    const stats = response.stats || {}
    return { results, stats }
  } finally {
    try { await onnxOcr.unload() } catch (e) { /* ignore */ }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

function formatTime (seconds) {
  if (!seconds) return '-'
  return seconds < 1
    ? `${(seconds * 1000).toFixed(0)}ms`
    : `${seconds.toFixed(2)}s`
}

function printTable (doctrStats, easyocrStats, doctrCount, easyocrCount) {
  const sep = '─'.repeat(52)
  console.log(`\n${sep}`)
  console.log('  DocTR vs EasyOCR Comparison')
  console.log(sep)
  console.log(`  ${'Metric'.padEnd(24)} ${'DocTR'.padStart(10)} ${'EasyOCR'.padStart(10)}`)
  console.log(`  ${'─'.repeat(24)} ${'─'.repeat(10)} ${'─'.repeat(10)}`)

  const rows = [
    ['Total time', formatTime(doctrStats.totalTime), formatTime(easyocrStats.totalTime)],
    ['Detection time', formatTime(doctrStats.detectionTime), formatTime(easyocrStats.detectionTime)],
    ['Recognition time', formatTime(doctrStats.recognitionTime), formatTime(easyocrStats.recognitionTime)],
    ['Text regions', String(doctrCount), String(easyocrCount)]
  ]

  for (const [metric, doctr, easyocr] of rows) {
    console.log(`  ${metric.padEnd(24)} ${doctr.padStart(10)} ${easyocr.padStart(10)}`)
  }

  if (doctrStats.totalTime && easyocrStats.totalTime) {
    const speedup = easyocrStats.totalTime / doctrStats.totalTime
    console.log(`  ${'─'.repeat(24)} ${'─'.repeat(10)} ${'─'.repeat(10)}`)
    console.log(`  ${'Speedup'.padEnd(24)} ${(speedup.toFixed(1) + 'x').padStart(10)}`)
  }

  console.log(sep)
}

async function main () {
  // Check image exists
  if (!fs.existsSync(IMAGE_PATH)) {
    console.error(`Image not found: ${IMAGE_PATH}`)
    process.exit(1)
  }

  // Check EasyOCR models exist
  if (!fs.existsSync(EASYOCR_DETECTOR) || !fs.existsSync(EASYOCR_RECOGNIZER)) {
    console.error('EasyOCR models not found in models/ocr/rec_dyn/')
    console.error('Please ensure detector_craft.onnx and recognizer_latin.onnx are available.')
    process.exit(1)
  }

  // Ensure DocTR models are downloaded
  await ensureDoctrModels()

  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  // Run DocTR
  const doctr = await runOCR('DocTR', {
    pathDetector: DB_MOBILENET,
    pathRecognizer: CRNN_MOBILENET,
    pipelineMode: 'doctr',
    decodingMethod: 'ctc',
    straightenPages: true
  })
  console.log(`DocTR: ${doctr.results.length} regions`)

  // Run EasyOCR
  const easyocr = await runOCR('EasyOCR', {
    pathDetector: EASYOCR_DETECTOR,
    pathRecognizer: EASYOCR_RECOGNIZER
  })
  console.log(`EasyOCR: ${easyocr.results.length} regions`)

  // Print comparison table
  printTable(doctr.stats, easyocr.stats, doctr.results.length, easyocr.results.length)

  // Save JSON results
  const doctrOut = { stats: doctr.stats, results: doctr.results }
  const easyocrOut = { stats: easyocr.stats, results: easyocr.results }

  const doctrPath = path.join(OUTPUT_DIR, 'demo_doctr.json')
  const easyocrPath = path.join(OUTPUT_DIR, 'demo_easyocr.json')

  fs.writeFileSync(doctrPath, JSON.stringify(doctrOut, null, 2))
  fs.writeFileSync(easyocrPath, JSON.stringify(easyocrOut, null, 2))

  console.log(`\nSaved: ${doctrPath}`)
  console.log(`Saved: ${easyocrPath}`)
  console.log(`\nTo visualize: python3 examples/demo-visualize.py`)
}

main().catch(e => { console.error(e); process.exit(1) })
