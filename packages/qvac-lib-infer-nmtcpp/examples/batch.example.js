'use strict'

/**
 * Batch Translation Example
 *
 * This example demonstrates how to use the runBatch() method to translate
 * multiple texts in a single batch operation, which is more efficient than
 * translating texts one at a time.
 *
 * Note: Source language is fixed to English (en). Target language depends on model (e.g., it, de, fr).
 *
 * Usage:
 *   bare examples/batch.example.js
 *   BERGAMOT_MODEL_PATH=/path/to/bergamot/enit bare examples/batch.example.js
 *
 * Environment Variables:
 *   BERGAMOT_MODEL_PATH - Path to Bergamot model directory (default: ./model/bergamot/enit)
 *
 * Enable verbose C++ logging:
 *   VERBOSE=1 bare examples/batch.example.js
 */

const TranslationNmtcpp = require('..')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

// ============================================================
// LOGGING CONFIGURATION
// Set VERBOSE=1 environment variable to enable C++ debug logs
// ============================================================
const VERBOSE = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true'

const logger = VERBOSE
  ? {
      info: (msg) => console.log('[C++ INFO]', msg),
      warn: (msg) => console.warn('[C++ WARN]', msg),
      error: (msg) => console.error('[C++ ERROR]', msg),
      debug: (msg) => console.log('[C++ DEBUG]', msg)
    }
  : null // null = suppress all C++ logs

// Sample texts to translate (English to target language based on model)
// Note: Source language is fixed to English (en). Target depends on model (e.g., it, de, fr).
const textsToTranslate = [
  'Hello world!',
  'How are you today?',
  'Machine translation has revolutionized communication.',
  'The weather is beautiful.',
  'Thank you for your help.'
]

async function testBatchTranslation () {
  console.log('\n=== Batch Translation Example ===\n')

  // Use local model path for Bergamot
  const bergamotPath = process.env.BERGAMOT_MODEL_PATH || './model/bergamot/enit'

  console.log('Model path:', bergamotPath)

  // Check if model directory exists
  if (!fs.existsSync(bergamotPath)) {
    console.log('Bergamot model directory not found!')
    console.log('Set BERGAMOT_MODEL_PATH env var or place model in ./model/bergamot/enit')
    console.log('\nNote: Source language is fixed to English (en). Target language depends on model (e.g., it, es, de, fr).')
    console.log('\nExpected files (auto-detected):')
    console.log('  - model.*.intgemm.*.bin (model weights)')
    console.log('  - vocab.*.spm or srcvocab.*.spm (source vocabulary)')
    console.log('  - trgvocab.*.spm (optional, target vocabulary if different from source)')
    console.log('\nExample:')
    console.log('  BERGAMOT_MODEL_PATH=/path/to/bergamot/enes bare examples/batch.example.js')
    return
  }

  // Auto-detect model and vocab files in the directory
  const files = fs.readdirSync(bergamotPath)
  const modelFile = files.find(f => f.includes('.intgemm.') && f.endsWith('.bin'))

  // Try to find vocab files: srcvocab/trgvocab (separate) or vocab (shared)
  let srcVocabFile = files.find(f => f.startsWith('srcvocab.') && f.endsWith('.spm'))
  let dstVocabFile = files.find(f => (f.startsWith('trgvocab.') || f.startsWith('dstvocab.')) && f.endsWith('.spm'))

  // Fallback to shared vocab file if separate ones not found
  if (!srcVocabFile) {
    srcVocabFile = files.find(f => f.startsWith('vocab.') && f.endsWith('.spm'))
  }
  if (!dstVocabFile) {
    dstVocabFile = srcVocabFile // Use same vocab for both if no separate dst vocab
  }

  if (!modelFile || !srcVocabFile) {
    console.log('Could not find required model files!')
    console.log('Found files:', files.join(', '))
    console.log('\nExpected: *.intgemm.*.bin and (srcvocab.*.spm or vocab.*.spm) files')
    return
  }

  console.log('Detected model file:', modelFile)
  console.log('Detected src vocab file:', srcVocabFile)
  console.log('Detected dst vocab file:', dstVocabFile)

  // Create a local file loader
  const localLoader = {
    ready: async () => {},
    close: async () => {},
    download: async (filename) => {
      const filePath = path.join(bergamotPath, filename)
      return fs.readFileSync(filePath)
    },
    getFileSize: async (filename) => {
      const filePath = path.join(bergamotPath, filename)
      const stats = fs.statSync(filePath)
      return stats.size
    }
  }

  // Create model args
  const args = {
    loader: localLoader,
    params: { mode: 'full', dstLang: 'it', srcLang: 'en' },
    diskPath: bergamotPath,
    modelName: modelFile,
    logger,
    opts: { stats: true }
  }

  // Config for Bergamot model
  const config = {
    srcVocabName: srcVocabFile,
    dstVocabName: dstVocabFile,
    modelType: TranslationNmtcpp.ModelTypes.Bergamot
  }

  // Create and load model
  const model = new TranslationNmtcpp(args, config)

  console.log('Loading model...')
  await model.load()
  console.log('Model loaded!\n')

  try {
    console.log('Input texts:')
    textsToTranslate.forEach((text, i) => {
      console.log(`  ${i + 1}. ${text}`)
    })

    // ---- Batch Translation ----
    console.log('\nTranslating batch...')
    const startTime = Date.now()

    // Use batch translation
    const translations = await model.runBatch(textsToTranslate)

    const batchElapsed = Date.now() - startTime
    const batchTokens = textsToTranslate.reduce((sum, t) => sum + t.split(/\s+/).filter(w => w.length > 0).length, 0)
    const batchE2eTps = (batchTokens / batchElapsed) * 1000

    console.log(`\nBatch translation completed in ${batchElapsed}ms\n`)

    console.log('Translations:')
    translations.forEach((text, i) => {
      console.log(`  ${i + 1}. ${text}`)
    })

    console.log('\n--- Batch Performance (End-to-End / JS wall-clock) ---')
    console.log(`Total time:     ${batchElapsed}ms`)
    console.log(`Total tokens:   ${batchTokens} (whitespace tokenization)`)
    console.log(`Tokens/sec:     ${batchE2eTps.toFixed(2)}`)

    // Native C++ stats from batch mode (now available via model.batchStats)
    const batchNativeStats = model.batchStats
    if (batchNativeStats && batchNativeStats.TPS !== undefined) {
      const nativeTps = batchNativeStats.TPS
      const nativeTokens = batchNativeStats.totalTokens || 0
      const nativeTimeMs = batchNativeStats.totalTime ? (batchNativeStats.totalTime * 1000).toFixed(2) : '?'
      const decodeTimeMs = batchNativeStats.decodeTime ? (batchNativeStats.decodeTime * 1000).toFixed(2) : '?'
      console.log('\n--- Batch Performance: Native C++ (model-internal) ---')
      console.log(`Native TPS (C++):       ${nativeTps.toFixed(2)} tokens/sec (${nativeTokens} tokens in ${nativeTimeMs}ms)`)
      console.log(`Decode time:            ${decodeTimeMs}ms`)
      if (batchNativeStats.encodeTime !== undefined) {
        console.log(`Encode time:            ${(batchNativeStats.encodeTime * 1000).toFixed(2)}ms`)
      }
      if (batchNativeStats.TTFT !== undefined) {
        console.log(`TTFT:                   ${batchNativeStats.TTFT.toFixed(2)}ms`)
      }
      const overhead = nativeTps > 0 ? (((nativeTps - batchE2eTps) / nativeTps) * 100) : 0
      console.log(`JS overhead:            ${overhead.toFixed(1)}%`)
    }

    // ---- Sequential Translation ----
    console.log('\n--- Comparison: Sequential vs Batch ---')

    const seqStartTime = Date.now()
    let lastNativeStats = null
    for (const text of textsToTranslate) {
      const response = await model.run(text)
      await response.await()
      // Capture cumulative C++ native stats (last response has totals)
      if (response.stats) {
        lastNativeStats = response.stats
      }
    }
    const seqElapsed = Date.now() - seqStartTime
    const seqTokens = textsToTranslate.reduce((sum, t) => sum + t.split(/\s+/).filter(w => w.length > 0).length, 0)
    const seqE2eTps = (seqTokens / seqElapsed) * 1000

    console.log(`\nSequential (${textsToTranslate.length} calls): ${seqElapsed}ms`)
    console.log(`Batch (1 call): ${batchElapsed}ms`)
    console.log(`Speedup: ${(seqElapsed / batchElapsed).toFixed(2)}x`)

    // Show TPS comparison for sequential mode
    console.log('\n--- TPS Comparison (Sequential mode) ---')
    console.log(`End-to-End TPS (JS):    ${seqE2eTps.toFixed(2)} tokens/sec (${seqTokens} tokens in ${seqElapsed}ms)`)
    if (lastNativeStats && lastNativeStats.TPS !== undefined) {
      const nativeTps = lastNativeStats.TPS
      const nativeTokens = lastNativeStats.totalTokens || 0
      const nativeTimeMs = lastNativeStats.totalTime ? (lastNativeStats.totalTime * 1000).toFixed(2) : '?'
      const decodeTimeMs = lastNativeStats.decodeTime ? (lastNativeStats.decodeTime * 1000).toFixed(2) : '?'
      console.log(`Native TPS (C++):       ${nativeTps.toFixed(2)} tokens/sec (${nativeTokens} tokens in ${nativeTimeMs}ms)`)
      console.log(`Decode time:            ${decodeTimeMs}ms`)
      if (lastNativeStats.encodeTime !== undefined) {
        console.log(`Encode time:            ${(lastNativeStats.encodeTime * 1000).toFixed(2)}ms`)
      }
      if (lastNativeStats.TTFT !== undefined) {
        console.log(`TTFT:                   ${lastNativeStats.TTFT.toFixed(2)}ms`)
      }
      const overhead = nativeTps > 0 ? (((nativeTps - seqE2eTps) / nativeTps) * 100) : 0
      console.log(`JS overhead:            ${overhead.toFixed(1)}%`)
    } else {
      console.log('Native TPS (C++):       N/A (stats not received)')
    }
  } finally {
    console.log('\nUnloading model...')
    await model.unload()
    await localLoader.close()
    console.log('Done!')
  }
}

testBatchTranslation().catch(console.error)
