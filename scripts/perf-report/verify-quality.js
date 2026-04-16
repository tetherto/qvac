#!/usr/bin/env node
'use strict'

/**
 * Quality metrics verification script.
 *
 * Re-calculates CER, WER, keyword detection, and key-value accuracy
 * from a performance-report.json file, then compares the recalculated
 * values against the values stored in the report. Exits non-zero if
 * any value differs.
 *
 * Usage:
 *   node scripts/perf-report/verify-quality.js <performance-report.json> [--ground-truth-dir <dir>]
 *   node scripts/perf-report/verify-quality.js --help
 */

const fs = require('fs')
const path = require('path')
const {
  tokenize,
  evaluateQuality
} = require('../test-utils/quality-metrics')

const DEFAULT_GT_DIR = path.resolve(__dirname, '../../packages/ocr-onnx/test/quality')

function parseArgs (argv) {
  const args = { reportPath: null, gtDir: DEFAULT_GT_DIR, help: false, verbose: false }
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--ground-truth-dir': args.gtDir = path.resolve(argv[++i]); break
      case '--verbose': case '-v': args.verbose = true; break
      case '--help': case '-h': args.help = true; break
      default:
        if (!argv[i].startsWith('-')) args.reportPath = path.resolve(argv[i])
    }
  }
  return args
}

function printHelp () {
  console.log(`
Quality Metrics Verification Script

Re-calculates quality metrics from a performance-report.json and compares
them against the values stored in the report. Use this to independently
audit that CER, WER, keyword detection, and KV accuracy numbers are correct.

USAGE:
  node scripts/perf-report/verify-quality.js <performance-report.json> [options]

OPTIONS:
  --ground-truth-dir <dir>  Directory containing .quality.json files
                            (default: packages/ocr-onnx/test/quality/)
  -v, --verbose             Show hypothesis/reference text previews
  -h, --help                Show this help

EXAMPLES:
  # Verify a downloaded iOS report
  node scripts/perf-report/verify-quality.js /tmp/ios-618/Apple_iPhone_16_Pro/performance-report.json

  # Verbose mode with text previews
  node scripts/perf-report/verify-quality.js report.json --verbose
`)
}

function round4 (v) {
  return Math.round(v * 10000) / 10000
}

function loadGroundTruth (testName, gtDir) {
  const base = testName
    .replace(/^\[DocTR\s+/, '')
    .replace(/\]\s*\[.*$/, '')
    .replace(/\]$/, '')
    .trim()

  const filename = base + '.quality.json'
  const candidate = path.join(gtDir, filename)
  try {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, 'utf-8'))
    }
  } catch (_) {}
  return null
}

function verifyResult (result, gt, verbose) {
  const output = result.output
  if (!output) return { skipped: true, reason: 'no output field' }
  if (!gt) return { skipped: true, reason: 'no ground truth found' }

  let texts
  try {
    texts = JSON.parse(output)
    if (!Array.isArray(texts)) texts = [String(output)]
  } catch (_) {
    texts = [String(output)]
  }

  const recalculated = evaluateQuality(texts, gt)
  const reported = result.quality || {}

  const diffs = []
  const metrics = {}

  if (recalculated.cer !== undefined) {
    const rc = round4(recalculated.cer)
    const rp = reported.cer
    metrics.cer = { recalculated: rc, reported: rp }
    if (rc !== rp) diffs.push({ metric: 'CER', recalculated: rc, reported: rp })
  }

  if (recalculated.wer !== undefined) {
    const rc = round4(recalculated.wer)
    const rp = reported.wer
    metrics.wer = { recalculated: rc, reported: rp }
    if (rc !== rp) diffs.push({ metric: 'WER', recalculated: rc, reported: rp })
  }

  if (recalculated.keyword_detection_rate !== undefined) {
    const rc = round4(recalculated.keyword_detection_rate)
    const rp = reported.keyword_detection_rate
    metrics.keyword_detection_rate = { recalculated: rc, reported: rp }
    if (rc !== rp) diffs.push({ metric: 'Keyword Detection', recalculated: rc, reported: rp })
  }

  if (recalculated.key_value_accuracy !== undefined) {
    const rc = round4(recalculated.key_value_accuracy)
    const rp = reported.key_value_accuracy
    metrics.key_value_accuracy = { recalculated: rc, reported: rp }
    if (rc !== rp) diffs.push({ metric: 'KV Accuracy', recalculated: rc, reported: rp })
  }

  let preview = null
  if (verbose && gt.reference_text) {
    const joined = texts.join(' ')
    const hSorted = tokenize(joined).sort().join(' ')
    const rSorted = tokenize(gt.reference_text).sort().join(' ')
    preview = {
      hypothesis: hSorted.substring(0, 200) + (hSorted.length > 200 ? '...' : ''),
      reference: rSorted.substring(0, 200) + (rSorted.length > 200 ? '...' : ''),
      hypothesis_tokens: tokenize(joined).length,
      reference_tokens: tokenize(gt.reference_text).length
    }
  }

  return {
    skipped: false,
    metrics,
    diffs,
    keywords_missing: recalculated.keywords_missing || [],
    kv_unmatched: (recalculated.key_values_unmatched || []).map(u => u.key),
    preview
  }
}

function main () {
  const args = parseArgs(process.argv)

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  if (!args.reportPath) {
    console.error('Error: provide a performance-report.json path')
    printHelp()
    process.exit(1)
  }

  if (!fs.existsSync(args.reportPath)) {
    console.error(`Error: file not found: ${args.reportPath}`)
    process.exit(1)
  }

  const report = JSON.parse(fs.readFileSync(args.reportPath, 'utf-8'))
  const results = report.results || []

  if (!results.length) {
    console.error('No results found in report.')
    process.exit(1)
  }

  console.log(`Verifying ${results.length} result(s) from: ${args.reportPath}`)
  console.log(`Ground truth dir: ${args.gtDir}`)
  if (report.device) console.log(`Device: ${report.device.name || 'unknown'}`)
  if (report.run_number) console.log(`Run: #${report.run_number}`)
  console.log('')

  const seen = new Set()
  let totalMismatch = 0
  let totalVerified = 0
  let totalSkipped = 0

  for (const result of results) {
    const testName = result.test
    const ep = result.execution_provider || '-'
    const key = `${testName}|${ep}`

    if (seen.has(key)) continue
    seen.add(key)

    const gt = loadGroundTruth(testName, args.gtDir)
    const v = verifyResult(result, gt, args.verbose)

    if (v.skipped) {
      console.log(`  SKIP  ${testName} [${ep}] — ${v.reason}`)
      totalSkipped++
      continue
    }

    totalVerified++
    const hasDiff = v.diffs.length > 0

    if (hasDiff) {
      totalMismatch++
      console.log(`  FAIL  ${testName} [${ep}]`)
      for (const d of v.diffs) {
        console.log(`        ${d.metric}: reported=${d.reported} recalculated=${d.recalculated}`)
      }
    } else {
      const m = v.metrics
      const cerStr = m.cer ? `CER=${(m.cer.recalculated * 100).toFixed(1)}%` : ''
      const werStr = m.wer ? `WER=${(m.wer.recalculated * 100).toFixed(1)}%` : ''
      const kwStr = m.keyword_detection_rate ? `KW=${(m.keyword_detection_rate.recalculated * 100).toFixed(1)}%` : ''
      const kvStr = m.key_value_accuracy ? `KV=${(m.key_value_accuracy.recalculated * 100).toFixed(1)}%` : ''
      const parts = [cerStr, werStr, kwStr, kvStr].filter(Boolean).join('  ')
      console.log(`  OK    ${testName} [${ep}]  ${parts}`)
    }

    if (v.keywords_missing.length > 0) {
      console.log(`        Missing keywords (${v.keywords_missing.length}): ${v.keywords_missing.slice(0, 5).join(', ')}${v.keywords_missing.length > 5 ? '...' : ''}`)
    }

    if (v.kv_unmatched.length > 0) {
      console.log(`        Unmatched KV keys (${v.kv_unmatched.length}): ${v.kv_unmatched.slice(0, 5).join(', ')}${v.kv_unmatched.length > 5 ? '...' : ''}`)
    }

    if (args.verbose && v.preview) {
      console.log(`        Hypothesis (${v.preview.hypothesis_tokens} tokens): ${v.preview.hypothesis}`)
      console.log(`        Reference  (${v.preview.reference_tokens} tokens): ${v.preview.reference}`)
    }

    console.log('')
  }

  console.log('---')
  console.log(`Verified: ${totalVerified}  Skipped: ${totalSkipped}  Mismatches: ${totalMismatch}`)

  if (totalMismatch > 0) {
    console.log('\nVERIFICATION FAILED — recalculated values differ from reported values.')
    process.exit(1)
  } else if (totalVerified > 0) {
    console.log('\nVERIFICATION PASSED — all recalculated values match the report.')
  }
}

main()
