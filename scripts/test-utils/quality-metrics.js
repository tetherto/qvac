'use strict'

/**
 * Quality/accuracy metrics for OCR and vision output validation.
 *
 * Computes CER, WER, keyword detection rate, and key-value extraction
 * accuracy by comparing OCR output against ground truth reference files.
 *
 * Compatible with both Node.js and Bare runtime.
 */

let fs, pathMod
let _configured = false

function _ensureNodeDefaults () {
  if (_configured) return
  fs = require('fs')
  pathMod = require('path')
}

/**
 * Inject runtime modules for Bare compatibility.
 * Must be called before any function that accesses the filesystem.
 *
 * @param {Object} mods
 * @param {Object} mods.fs   - bare-fs or Node fs
 * @param {Object} mods.path - bare-path or Node path
 */
function configure (mods) {
  fs = mods.fs
  pathMod = mods.path
  _configured = true
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

function normalize (text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[\t\v\f]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .toLowerCase()
}

function tokenize (text) {
  return normalize(text).split(/\s+/).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Levenshtein distance (Wagner-Fischer)
// ---------------------------------------------------------------------------

function levenshtein (a, b) {
  const m = a.length
  const n = b.length

  if (m === 0) return n
  if (n === 0) return m

  let prev = new Array(n + 1)
  let curr = new Array(n + 1)

  for (let j = 0; j <= n; j++) prev[j] = j

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      )
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }

  return prev[n]
}

// ---------------------------------------------------------------------------
// Core quality metrics
// ---------------------------------------------------------------------------

/**
 * Character Error Rate — edit distance at the character level.
 * Tokens are sorted alphabetically before comparison so that
 * reading-order differences (e.g. mobile bottom-to-top vs desktop
 * top-to-bottom) do not inflate the error rate.
 * CER = levenshtein(sorted_hypothesis, sorted_reference) / len(sorted_reference)
 * Lower is better. 0 = perfect.
 */
function cer (hypothesis, reference) {
  const h = tokenize(hypothesis).sort().join(' ')
  const r = tokenize(reference).sort().join(' ')
  if (r.length === 0) return h.length === 0 ? 0 : 1
  return levenshtein(h, r) / r.length
}

/**
 * Word Error Rate — edit distance at the word level.
 * Tokens are sorted alphabetically before comparison so that
 * reading-order differences do not inflate the error rate.
 * WER = levenshtein(sorted_hyp_words, sorted_ref_words) / len(sorted_ref_words)
 * Lower is better. 0 = perfect.
 */
function wer (hypothesis, reference) {
  const h = tokenize(hypothesis).sort()
  const r = tokenize(reference).sort()
  if (r.length === 0) return h.length === 0 ? 0 : 1
  return levenshtein(h, r) / r.length
}

/**
 * Check whether every word in `phrase` appears somewhere in the
 * pre-tokenised word set.  Handles multi-word keywords that may be
 * split across OCR text regions in arbitrary reading order.
 */
function _phraseWordsPresent (phrase, wordSet) {
  const words = phrase.toLowerCase().split(/\s+/).filter(Boolean)
  return words.every(w => wordSet.has(w))
}

/**
 * Keyword Detection Rate — what fraction of expected keywords appear
 * anywhere in the OCR output.
 *
 * Single-word keywords use a fast Set lookup.
 * Multi-word keywords first try an exact substring match; if that
 * fails they check whether every constituent word exists anywhere
 * in the output (order-independent).
 *
 * Returns { rate, found, missing, total }.
 */
function keywordDetectionRate (ocrTexts, expectedKeywords) {
  const joined = (Array.isArray(ocrTexts) ? ocrTexts.join(' ') : String(ocrTexts)).toLowerCase()
  const wordSet = new Set(joined.split(/\s+/).filter(Boolean))
  const found = []
  const missing = []

  for (const kw of expectedKeywords) {
    const target = kw.toLowerCase()
    if (joined.includes(target) || _phraseWordsPresent(target, wordSet)) {
      found.push(kw)
    } else {
      missing.push(kw)
    }
  }

  return {
    rate: expectedKeywords.length > 0 ? found.length / expectedKeywords.length : 1,
    found,
    missing,
    total: expectedKeywords.length
  }
}

/**
 * Key-Value Extraction Accuracy — for structured documents, checks if the
 * OCR output contains both the key and its expected value.
 *
 * Each entry in `expectedPairs` should be { key, value }.
 * Multi-word keys use word-level matching (all words present anywhere)
 * so reading-order differences don't cause false negatives.
 * Values are checked as exact substrings.
 *
 * Returns { rate, matched, unmatched, total }.
 */
function keyValueAccuracy (ocrTexts, expectedPairs) {
  const joined = (Array.isArray(ocrTexts) ? ocrTexts.join(' ') : String(ocrTexts)).toLowerCase()
  const wordSet = new Set(joined.split(/\s+/).filter(Boolean))
  const matched = []
  const unmatched = []

  for (const pair of expectedPairs) {
    const keyLower = pair.key.toLowerCase()
    const keyFound = joined.includes(keyLower) || _phraseWordsPresent(keyLower, wordSet)
    const valueFound = joined.includes(String(pair.value).toLowerCase())

    if (keyFound && valueFound) {
      matched.push(pair)
    } else {
      unmatched.push({ ...pair, key_found: keyFound, value_found: valueFound })
    }
  }

  return {
    rate: expectedPairs.length > 0 ? matched.length / expectedPairs.length : 1,
    matched,
    unmatched,
    total: expectedPairs.length
  }
}

// ---------------------------------------------------------------------------
// Ground truth loading
// ---------------------------------------------------------------------------

/**
 * Loads a ground truth JSON file.
 * @param {string} gtPath - Absolute or relative path to the .json file
 * @returns {Object|null} Parsed ground truth or null on failure
 */
function loadGroundTruth (gtPath) {
  _ensureNodeDefaults()
  try {
    const raw = fs.readFileSync(gtPath, 'utf-8')
    return JSON.parse(raw)
  } catch (err) {
    console.log(`[quality] failed to load ground truth from ${gtPath}: ${err.message}`)
    return null
  }
}

/**
 * Finds the ground truth file for a given test image.
 * Convention: for image `foo.png`, look for `foo.quality.json` in the
 * same directory, then in `../quality/foo.quality.json`.
 *
 * @param {string} imagePath - Path to the test image
 * @returns {Object|null} Ground truth data or null if not found
 */
function findGroundTruth (imagePath) {
  _ensureNodeDefaults()
  const dir = pathMod.dirname(imagePath)
  const base = pathMod.basename(imagePath).replace(/\.[^.]+$/, '')
  const filename = base + '.quality.json'

  const candidates = [
    pathMod.join(dir, filename),
    pathMod.join(dir, '..', 'quality', filename),
    pathMod.join(dir, 'quality', filename)
  ]

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return loadGroundTruth(candidate)
      }
    } catch (_) {}
  }

  return null
}

/**
 * Word Recognition Rate — what fraction of unique reference words appear
 * anywhere in the OCR output (single-word substring match).
 *
 * This is the same method used by the Android benchmark script: tokenize
 * the reference text into individual words, then check each one against
 * the joined OCR output. Because it operates on single words it is
 * inherently order-independent and tolerant of extra/missing whitespace.
 *
 * Returns { rate, matched, missed, total }.
 */
function wordRecognitionRate (ocrTexts, referenceText) {
  const joined = (Array.isArray(ocrTexts) ? ocrTexts.join(' ') : String(ocrTexts)).toLowerCase()
  const refWords = [...new Set(tokenize(referenceText))]
  const matched = []
  const missed = []

  for (const w of refWords) {
    if (joined.includes(w)) {
      matched.push(w)
    } else {
      missed.push(w)
    }
  }

  return {
    rate: refWords.length > 0 ? matched.length / refWords.length : 1,
    matched,
    missed,
    total: refWords.length
  }
}

// ---------------------------------------------------------------------------
// Full quality evaluation
// ---------------------------------------------------------------------------

/**
 * Runs all quality checks against a ground truth file.
 *
 * @param {string[]} ocrTexts - Array of detected text strings from OCR
 * @param {Object} groundTruth - Parsed ground truth object
 * @returns {Object} Quality result with all metric scores
 */
function evaluateQuality (ocrTexts, groundTruth) {
  const texts = Array.isArray(ocrTexts) ? ocrTexts : [String(ocrTexts)]
  const joinedOutput = texts.join(' ')
  const gt = groundTruth

  const result = {
    ground_truth_id: gt.id || null,
    description: gt.description || null
  }

  if (gt.reference_text) {
    result.cer = round4(cer(joinedOutput, gt.reference_text))
    result.wer = round4(wer(joinedOutput, gt.reference_text))

    const wrr = wordRecognitionRate(texts, gt.reference_text)
    result.word_recognition_rate = round4(wrr.rate)
    result.words_recognized = wrr.matched.length
    result.words_total = wrr.total
    result.words_missed = wrr.missed
  }

  if (gt.required_keywords && gt.required_keywords.length > 0) {
    const kdr = keywordDetectionRate(texts, gt.required_keywords)
    result.keyword_detection_rate = round4(kdr.rate)
    result.keywords_found = kdr.found.length
    result.keywords_total = kdr.total
    result.keywords_missing = kdr.missing
  }

  if (gt.key_values && gt.key_values.length > 0) {
    const kva = keyValueAccuracy(texts, gt.key_values)
    result.key_value_accuracy = round4(kva.rate)
    result.key_values_matched = kva.matched.length
    result.key_values_total = kva.total
    result.key_values_unmatched = kva.unmatched
  }

  return result
}

function round4 (v) {
  return Math.round(v * 10000) / 10000
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  configure,
  normalize,
  tokenize,
  levenshtein,
  cer,
  wer,
  keywordDetectionRate,
  keyValueAccuracy,
  wordRecognitionRate,
  loadGroundTruth,
  findGroundTruth,
  evaluateQuality
}

