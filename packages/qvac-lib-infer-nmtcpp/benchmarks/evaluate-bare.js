'use strict'

/**
 * Bare-based Translation Evaluation Script
 *
 * Evaluates translation quality using BLEU score and measures performance (tokens/sec)
 * Uses FLORES devtest dataset format
 *
 * Usage:
 *   bare benchmarks/evaluate-bare.js --model-path ./model/bergamot/enit/2025-11-26 --src-lang en --tgt-lang it
 *   bare benchmarks/evaluate-bare.js --model-path ./model/indictrans --src-lang en --tgt-lang hi --model-type IndicTrans
 */

const TranslationNmtcpp = require('..')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

// FLORES-200 language codes (matching evaluate.py)
const FLORES_LANG_CODES = {
  en: 'eng_Latn',
  it: 'ita_Latn',
  de: 'deu_Latn',
  es: 'spa_Latn',
  fr: 'fra_Latn',
  pt: 'por_Latn',
  nl: 'nld_Latn',
  pl: 'pol_Latn',
  ru: 'rus_Cyrl',
  zh: 'zho_Hans',
  ja: 'jpn_Jpan',
  ko: 'kor_Hang',
  ar: 'arb_Arab',
  hi: 'hin_Deva',
  tr: 'tur_Latn',
  vi: 'vie_Latn',
  cs: 'ces_Latn',
  da: 'dan_Latn',
  el: 'ell_Grek',
  fi: 'fin_Latn',
  hu: 'hun_Latn',
  id: 'ind_Latn',
  ro: 'ron_Latn',
  sv: 'swe_Latn',
  th: 'tha_Thai',
  uk: 'ukr_Cyrl',
  bg: 'bul_Cyrl',
  hr: 'hrv_Latn',
  sk: 'slk_Latn',
  sl: 'slv_Latn',
  et: 'est_Latn',
  lv: 'lvs_Latn',
  lt: 'lit_Latn',
  mt: 'mlt_Latn',
  he: 'heb_Hebr',
  fa: 'pes_Arab',
  bn: 'ben_Beng',
  ta: 'tam_Taml',
  te: 'tel_Telu',
  mr: 'mar_Deva',
  ur: 'urd_Arab',
  tl: 'tgl_Latn',
  ms: 'zsm_Latn',
  ca: 'cat_Latn'
}

// Simple BLEU score implementation (unigram to 4-gram)
function calculateBLEU (reference, hypothesis) {
  // Ensure inputs are strings
  const ref = String(reference || '')
  const hyp = String(hypothesis || '')

  const refTokens = ref.toLowerCase().split(/\s+/).filter(t => t.length > 0)
  const hypTokens = hyp.toLowerCase().split(/\s+/).filter(t => t.length > 0)

  if (hypTokens.length === 0) return 0

  let totalScore = 0
  const weights = [0.25, 0.25, 0.25, 0.25] // Equal weights for 1-4 grams

  for (let n = 1; n <= 4; n++) {
    const refNgrams = getNgrams(refTokens, n)
    const hypNgrams = getNgrams(hypTokens, n)

    if (hypNgrams.length === 0) continue

    let matches = 0
    const refNgramCounts = {}

    // Count reference n-grams
    for (const ng of refNgrams) {
      refNgramCounts[ng] = (refNgramCounts[ng] || 0) + 1
    }

    // Count matches (with clipping)
    const hypNgramCounts = {}
    for (const ng of hypNgrams) {
      hypNgramCounts[ng] = (hypNgramCounts[ng] || 0) + 1
    }

    for (const ng in hypNgramCounts) {
      if (refNgramCounts[ng]) {
        matches += Math.min(hypNgramCounts[ng], refNgramCounts[ng])
      }
    }

    const precision = matches / hypNgrams.length
    if (precision > 0) {
      totalScore += weights[n - 1] * Math.log(precision)
    } else {
      totalScore += weights[n - 1] * Math.log(0.0001) // Smoothing
    }
  }

  // Brevity penalty
  const bp = hypTokens.length >= refTokens.length
    ? 1
    : Math.exp(1 - refTokens.length / hypTokens.length)

  return bp * Math.exp(totalScore) * 100 // Return as percentage
}

function getNgrams (tokens, n) {
  const ngrams = []
  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.push(tokens.slice(i, i + n).join(' '))
  }
  return ngrams
}

// Count tokens (simple whitespace tokenization)
function countTokens (text) {
  return text.split(/\s+/).filter(t => t.length > 0).length
}

// Load FLORES dataset
function loadFloresDataset (datasetPath, srcLang, tgtLang, split = 'devtest') {
  const srcCode = FLORES_LANG_CODES[srcLang] || srcLang
  const tgtCode = FLORES_LANG_CODES[tgtLang] || tgtLang

  const srcFile = path.join(datasetPath, split, `${srcCode}.${split}`)
  const tgtFile = path.join(datasetPath, split, `${tgtCode}.${split}`)

  if (!fs.existsSync(srcFile) || !fs.existsSync(tgtFile)) {
    return null
  }

  const srcLines = fs.readFileSync(srcFile, 'utf-8').trim().split('\n')
  const tgtLines = fs.readFileSync(tgtFile, 'utf-8').trim().split('\n')

  return srcLines.map((src, i) => ({
    source: src,
    reference: tgtLines[i]
  }))
}

// Sample test sentences (fallback if no dataset)
const SAMPLE_SENTENCES = [
  { source: 'Hello, how are you today?', reference: 'Ciao, come stai oggi?' },
  { source: 'The weather is beautiful.', reference: 'Il tempo è bellissimo.' },
  { source: 'Thank you for your help.', reference: 'Grazie per il tuo aiuto.' },
  { source: 'I would like to order a coffee.', reference: 'Vorrei ordinare un caffè.' },
  { source: 'Where is the train station?', reference: 'Dov\'è la stazione ferroviaria?' },
  { source: 'Machine translation has improved significantly.', reference: 'La traduzione automatica è migliorata significativamente.' },
  { source: 'The book is on the table.', reference: 'Il libro è sul tavolo.' },
  { source: 'She speaks three languages fluently.', reference: 'Lei parla tre lingue fluentemente.' },
  { source: 'We need to finish this project by tomorrow.', reference: 'Dobbiamo finire questo progetto entro domani.' },
  { source: 'The restaurant serves excellent Italian food.', reference: 'Il ristorante serve ottimo cibo italiano.' }
]

async function main () {
  const args = process.argv.slice(2)

  // Parse arguments - no hardcoded defaults for model path
  let modelPath = ''
  let srcLang = 'en'
  let tgtLang = 'it'
  let modelType = 'Bergamot'
  let datasetPath = './benchmarks/flores200_dataset'
  let maxSentences = 0 // 0 = all
  let useBatch = true

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--model-path':
        modelPath = args[++i]
        break
      case '--src-lang':
        srcLang = args[++i]
        break
      case '--tgt-lang':
        tgtLang = args[++i]
        break
      case '--model-type':
        modelType = args[++i]
        break
      case '--dataset':
        datasetPath = args[++i]
        break
      case '--max':
        maxSentences = parseInt(args[++i])
        break
      case '--sequential':
        useBatch = false
        break
      case '--help':
        console.log(`
Usage: bare benchmarks/evaluate-bare.js --model-path <path> [options]

Required:
  --model-path <path>   Path to model directory

Options:
  --model-type <type>   Model type: Bergamot or IndicTrans (default: Bergamot)
  --src-lang <lang>     Source language code (default: en)
  --tgt-lang <lang>     Target language code (default: it)
  --dataset <path>      Path to FLORES dataset (default: ./flores200_dataset)
  --max <n>             Max sentences to evaluate (default: all)
  --sequential          Use sequential instead of batch translation
  --help                Show this help

Examples:
  bare benchmarks/evaluate-bare.js --model-path ./model/bergamot/enit/2025-11-26
  bare benchmarks/evaluate-bare.js --model-path ./model/indictrans --model-type IndicTrans
  bare benchmarks/evaluate-bare.js --model-path ./model/bergamot/enit/2025-11-26 --max 50
        `)
        return
    }
  }

  // Check required arguments
  if (!modelPath) {
    console.error('❌ Error: --model-path is required')
    console.log('')
    console.log('Usage: bare benchmarks/evaluate-bare.js --model-path <path> [options]')
    console.log('')
    console.log('Examples:')
    console.log('  bare benchmarks/evaluate-bare.js --model-path ./model/bergamot/enit/2025-11-26')
    console.log('  bare benchmarks/evaluate-bare.js --model-path ./model/indictrans --model-type IndicTrans')
    console.log('')
    console.log('Use --help for more options')
    process.exit(1)
  }

  console.log('==========================================')
  console.log('  Translation Evaluation (Bare-based)')
  console.log('==========================================')
  console.log('')
  console.log(`Model path:  ${modelPath}`)
  console.log(`Source lang: ${srcLang}`)
  console.log(`Target lang: ${tgtLang}`)
  console.log(`Model type:  ${modelType}`)
  console.log(`Mode:        ${useBatch ? 'Batch' : 'Sequential'}`)
  console.log('')

  // Check model exists — auto-download Bergamot models if missing
  if (!fs.existsSync(modelPath)) {
    if (modelType === 'Bergamot') {
      console.log(`⬇️  Bergamot model not found at ${modelPath}, downloading via Hyperdrive / Firefox CDN...`)
      try {
        const { ensureBergamotModelFiles } = require('../lib/bergamot-model-fetcher.js')
        await ensureBergamotModelFiles(srcLang, tgtLang, modelPath)
        console.log(`✓ Model downloaded to ${modelPath}`)
      } catch (dlErr) {
        console.error(`❌ Auto-download failed: ${dlErr.message}`)
        process.exit(1)
      }
    } else {
      console.error(`❌ Model path not found: ${modelPath}`)
      process.exit(1)
    }
  }

  // Load dataset or use samples
  let dataset = loadFloresDataset(datasetPath, srcLang, tgtLang)
  if (!dataset) {
    console.log('⚠️  FLORES dataset not found, using sample sentences')
    dataset = SAMPLE_SENTENCES
  } else {
    console.log(`✓ Loaded ${dataset.length} sentences from FLORES devtest`)
  }

  if (maxSentences > 0 && maxSentences < dataset.length) {
    dataset = dataset.slice(0, maxSentences)
    console.log(`  Using first ${maxSentences} sentences`)
  }
  console.log('')

  // Detect model file
  const files = fs.readdirSync(modelPath)
  // Prefer files starting with 'model' (avoid lex.*.bin files)
  const modelName = files.find(f => f.startsWith('model') && f.endsWith('.bin')) ||
                    files.find(f => f.endsWith('.bin'))

  // Detect vocabulary files - check for separate src/trg vocabs first
  // Patterns: srcvocab.enja.spm, trgvocab.enja.spm (or .src.spm, .trg.spm variants)
  let srcVocabName = files.find(f => f.startsWith('srcvocab') && f.endsWith('.spm')) ||
                     files.find(f => f.includes('.src.spm') || f.includes('_src.spm'))
  let tgtVocabName = files.find(f => f.startsWith('trgvocab') && f.endsWith('.spm')) ||
                     files.find(f => f.includes('.trg.spm') || f.includes('_trg.spm') ||
                                     f.includes('.tgt.spm') || f.includes('_tgt.spm'))

  // If no separate vocabs, look for shared vocab
  if (!srcVocabName && !tgtVocabName) {
    const sharedVocab = files.find(f => f.endsWith('.spm'))
    srcVocabName = sharedVocab
    tgtVocabName = sharedVocab
  }

  if (!modelName) {
    console.error('❌ No .bin model file found in', modelPath)
    process.exit(1)
  }

  console.log(`Model file:  ${modelName}`)
  if (srcVocabName === tgtVocabName) {
    console.log(`Vocab file:  ${srcVocabName || 'auto'} (shared)`)
  } else {
    console.log(`Src vocab:   ${srcVocabName || 'auto'}`)
    console.log(`Tgt vocab:   ${tgtVocabName || 'auto'}`)
  }
  console.log('')

  // Create loader
  const loader = {
    ready: async () => {},
    close: async () => {},
    download: async (filename) => {
      const filePath = path.join(modelPath, filename)
      return fs.readFileSync(filePath)
    },
    getFileSize: async (filename) => {
      const filePath = path.join(modelPath, filename)
      return fs.statSync(filePath).size
    }
  }

  // Create model config
  const modelArgs = {
    loader,
    params: { srcLang, dstLang: tgtLang },
    diskPath: modelPath,
    modelName
  }

  const config = {
    modelType: TranslationNmtcpp.ModelTypes[modelType] || modelType
  }

  if (modelType === 'Bergamot') {
    if (srcVocabName) config.srcVocabName = srcVocabName
    if (tgtVocabName) config.dstVocabName = tgtVocabName
  }

  // Load model
  console.log('Loading model...')
  const loadStart = Date.now()
  const model = new TranslationNmtcpp(modelArgs, config)
  await model.load()
  const loadTime = Date.now() - loadStart
  console.log(`✓ Model loaded in ${loadTime}ms`)
  console.log('')

  // Run translations
  console.log('Running translations...')
  const sources = dataset.map(d => d.source)
  const references = dataset.map(d => d.reference)
  let translations = []
  let totalTokens = 0

  const translateStart = Date.now()

  if (useBatch) {
    const batchResults = await model.runBatch(sources)
    // Ensure all results are strings
    translations = batchResults.map(r => {
      if (typeof r === 'string') return r
      if (Array.isArray(r)) return r[0] || ''
      if (r && r.translation) return r.translation
      return String(r || '')
    })
  } else {
    // Sequential mode - translate one by one with progress
    const total = sources.length
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i]
      const response = await model.run(src)

      // Accumulate all chunks from onUpdate (critical for full translation!)
      let result = ''
      await response
        .onUpdate(chunk => {
          result += chunk
        })
        .await()

      translations.push(result)

      // Show progress every 10 sentences or at milestones
      if ((i + 1) % 10 === 0 || i + 1 === total) {
        const pct = ((i + 1) / total * 100).toFixed(1)
        const elapsed = Date.now() - translateStart
        const eta = Math.round((elapsed / (i + 1)) * (total - i - 1) / 1000)
        console.log(`  Progress: ${i + 1}/${total} (${pct}%) - ETA: ${eta}s`)
      }
    }
  }

  const translateTime = Date.now() - translateStart

  // Calculate metrics
  console.log('Calculating metrics...')
  console.log('')

  let totalBleu = 0
  const results = []

  for (let i = 0; i < translations.length; i++) {
    const src = sources[i]
    const ref = references[i]
    const hyp = translations[i]
    const bleu = calculateBLEU(ref, hyp)
    const srcTokens = countTokens(src)
    const hypTokens = countTokens(hyp)

    totalTokens += srcTokens
    totalBleu += bleu

    results.push({ src, ref, hyp, bleu, srcTokens, hypTokens })
  }

  const avgBleu = totalBleu / translations.length
  const tokensPerSec = (totalTokens / translateTime) * 1000

  // Print results
  console.log('==========================================')
  console.log('  Results')
  console.log('==========================================')
  console.log('')
  console.log(`Sentences:      ${translations.length}`)
  console.log(`Total tokens:   ${totalTokens}`)
  console.log(`Translate time: ${translateTime}ms`)
  console.log('')
  console.log('--- Performance ---')
  console.log(`Tokens/sec:     ${tokensPerSec.toFixed(2)}`)
  console.log(`Ms/sentence:    ${(translateTime / translations.length).toFixed(2)}`)
  console.log('')
  console.log('--- Quality ---')
  console.log(`Average BLEU:   ${avgBleu.toFixed(2)}`)
  console.log('')

  // Sample translations
  console.log('--- Sample Translations ---')
  for (let i = 0; i < Math.min(5, results.length); i++) {
    const r = results[i]
    console.log(`[${i + 1}] BLEU: ${r.bleu.toFixed(1)}`)
    console.log(`    SRC: ${r.src.substring(0, 60)}${r.src.length > 60 ? '...' : ''}`)
    console.log(`    REF: ${r.ref.substring(0, 60)}${r.ref.length > 60 ? '...' : ''}`)
    console.log(`    HYP: ${r.hyp.substring(0, 60)}${r.hyp.length > 60 ? '...' : ''}`)
    console.log('')
  }

  // Cleanup
  await model.unload()

  // Summary JSON
  const summary = {
    model: modelPath,
    modelType,
    srcLang,
    tgtLang,
    mode: useBatch ? 'batch' : 'sequential',
    sentences: translations.length,
    totalTokens,
    translateTimeMs: translateTime,
    loadTimeMs: loadTime,
    tokensPerSec: parseFloat(tokensPerSec.toFixed(2)),
    msPerSentence: parseFloat((translateTime / translations.length).toFixed(2)),
    bleuScore: parseFloat(avgBleu.toFixed(2))
  }

  console.log('--- Summary JSON ---')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
