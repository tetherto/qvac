#!/usr/bin/env node
'use strict'

/**
 * Download OCR models from the QVAC registry into models/ocr/rec_dyn/.
 * Uses the same registry client as examples/utils.js.
 *
 * Usage:
 *   node scripts/download-ocr-models.js              # detector + latin only
 *   node scripts/download-ocr-models.js korean       # also download recognizer_korean
 *   node scripts/download-ocr-models.js korean arabic # multiple recognizers
 *   node scripts/download-ocr-models.js all           # all recognizers used by full-ocr-suite
 */

const fs = require('fs')
const path = require('path')
const { QVACRegistryClient } = require('@qvac/registry-client')

const DEFAULT_REGISTRY_CORE_KEY = process.env.QVAC_REGISTRY_CORE_KEY || 'u6pq8h3kof7ck9g6kjusykfxaxqaqtnoydq15hhyuzrf55nt384y'
const OUT_DIR = path.resolve(__dirname, '..', 'models', 'ocr', 'rec_dyn')
const REGISTRY_BASE = process.env.QVAC_OCR_REGISTRY_BASE || 'qvac_models_compiled/ocr/2026-02-12/rec_dyn'

const MODELS = {
  detector_craft: {
    path: 'qvac_models_compiled/ocr/2026-02-12/rec_512/detector_craft.onnx',
    filename: 'detector_craft.onnx'
  },
  recognizer_latin: { path: `${REGISTRY_BASE}/recognizer_latin.onnx`, filename: 'recognizer_latin.onnx' },
  recognizer_korean: { path: `${REGISTRY_BASE}/recognizer_korean.onnx`, filename: 'recognizer_korean.onnx' },
  recognizer_arabic: { path: `${REGISTRY_BASE}/recognizer_arabic.onnx`, filename: 'recognizer_arabic.onnx' },
  recognizer_cyrillic: { path: `${REGISTRY_BASE}/recognizer_cyrillic.onnx`, filename: 'recognizer_cyrillic.onnx' },
  recognizer_devanagari: { path: `${REGISTRY_BASE}/recognizer_devanagari.onnx`, filename: 'recognizer_devanagari.onnx' },
  recognizer_bengali: { path: `${REGISTRY_BASE}/recognizer_bengali.onnx`, filename: 'recognizer_bengali.onnx' },
  recognizer_thai: { path: `${REGISTRY_BASE}/recognizer_thai.onnx`, filename: 'recognizer_thai.onnx' },
  recognizer_zh_sim: { path: `${REGISTRY_BASE}/recognizer_zh_sim.onnx`, filename: 'recognizer_zh_sim.onnx' },
  recognizer_zh_tra: { path: `${REGISTRY_BASE}/recognizer_zh_tra.onnx`, filename: 'recognizer_zh_tra.onnx' },
  recognizer_japanese: { path: `${REGISTRY_BASE}/recognizer_japanese.onnx`, filename: 'recognizer_japanese.onnx' },
  recognizer_tamil: { path: `${REGISTRY_BASE}/recognizer_tamil.onnx`, filename: 'recognizer_tamil.onnx' },
  recognizer_telugu: { path: `${REGISTRY_BASE}/recognizer_telugu.onnx`, filename: 'recognizer_telugu.onnx' },
  recognizer_kannada: { path: `${REGISTRY_BASE}/recognizer_kannada.onnx`, filename: 'recognizer_kannada.onnx' }
}

const FULL_OCR_SUITE_RECOGNIZERS = ['latin', 'korean', 'arabic', 'cyrillic', 'devanagari', 'bengali', 'thai', 'zh_sim', 'zh_tra', 'japanese', 'tamil', 'telugu', 'kannada']

async function main () {
  const args = process.argv.slice(2).map(a => a.toLowerCase())
  const wantAll = args.includes('all')
  const requested = args.filter(a => a !== 'all')

  const toDownload = ['detector_craft', 'recognizer_latin']
  if (wantAll) {
    for (const name of FULL_OCR_SUITE_RECOGNIZERS) {
      toDownload.push(`recognizer_${name}`)
    }
  } else {
    for (const name of requested) {
      const key = name.startsWith('recognizer_') ? name : `recognizer_${name}`
      if (MODELS[key]) toDownload.push(key)
      else console.warn(`Unknown model: ${name} (skipping)`)
    }
  }
  const unique = [...new Set(toDownload)]

  fs.mkdirSync(OUT_DIR, { recursive: true })

  console.log('Downloading OCR models from registry...')
  console.log('  Output dir:', OUT_DIR)
  console.log('  Models:', unique.join(', '))

  const client = new QVACRegistryClient({ registryCoreKey: DEFAULT_REGISTRY_CORE_KEY })
  try {
    await client.ready()
    for (const key of unique) {
      const model = MODELS[key]
      if (!model) continue
      const outPath = path.join(OUT_DIR, model.filename)
      if (fs.existsSync(outPath)) {
        console.log(`  ✓ ${model.filename} (already exists)`)
        continue
      }
      try {
        console.log(`  Downloading ${model.filename}...`)
        await client.downloadModel(model.path, 's3', { outputFile: outPath, timeout: 120000 })
        console.log(`  ✓ ${model.filename}`)
      } catch (err) {
        console.error(`  ✗ ${model.filename}: ${err.message}`)
      }
    }
  } finally {
    await client.close()
  }
  console.log('Done.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
