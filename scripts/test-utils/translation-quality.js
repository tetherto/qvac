'use strict'

/**
 * Translation quality metrics for NMT output validation.
 *
 * Computes chrF++ (character + word n-gram F-score, beta=2), matching
 * sacrebleu's `-m chrf --chrf-word-order 2` formulation. This aligns with
 * the repo-wide NMT quality metric used by
 * `packages/qvac-lib-infer-nmtcpp/benchmarks/quality_eval/evaluate.py`
 * for comparing QVAC against OpusMT / Google / NLLB / Bergamot on
 * FLORES-200. Integration-test scores are therefore directly comparable
 * to benchmark scores.
 *
 * chrF++ extends chrF-2 (character n-grams, n=1..charOrder, default 6)
 * with word n-grams (n=1..wordOrder, default 2). Precision and recall
 * are averaged uniformly across all n-gram orders (char + word pooled),
 * then combined into F-beta with beta=2.
 *
 * Ground truth fixtures are JSON arrays of entries keyed by
 * { source, src_lang, dst_lang } so a single fixture can serve multiple
 * translation calls in the same test file.
 *
 * Scores are in [0, 1] to match the CER/WER convention used by
 * scripts/test-utils/quality-metrics.js. Case-sensitive by default to
 * mirror sacrebleu; pass `{caseSensitive: false}` if model output casing
 * is known to vary and shouldn't be penalized.
 *
 * Compatible with both Node.js and Bare runtime.
 */

let fs
let _configured = false

function _ensureNodeDefaults () {
  if (_configured) return
  fs = require('fs')
  _configured = true
}

/**
 * Inject runtime modules for Bare compatibility.
 * Must be called before any function that accesses the filesystem.
 *
 * Accepts `{fs, path}` for parity with quality-metrics.js; only `fs` is
 * used here (fixture paths are pre-resolved by callers).
 *
 * @param {Object} mods
 * @param {Object} mods.fs     - bare-fs or Node fs
 * @param {Object} [mods.path] - accepted for parity, unused
 */
function configure (mods) {
  fs = mods.fs
  _configured = true
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

/**
 * Whitespace cleanup only — matches sacrebleu's default chrF behaviour
 * (preserves case).
 */
function _cleanWhitespace (text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[\t\v\f]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/**
 * Full normalization: whitespace cleanup + lowercasing. Exposed for
 * callers that want case-insensitive text comparison; chrF++ itself
 * defaults to case-sensitive per sacrebleu.
 */
function normalize (text) {
  return _cleanWhitespace(text).toLowerCase()
}

// ---------------------------------------------------------------------------
// N-gram extraction
// ---------------------------------------------------------------------------

/**
 * Character n-gram frequency map. Internal whitespace is stripped before
 * extraction, matching sacrebleu's default chrF whitespace handling.
 *
 * @param {string} text - whitespace-cleaned input
 * @param {number} n    - n-gram order
 * @returns {Map<string, number>}
 */
function _extractCharNgrams (text, n) {
  const stripped = text.replace(/\s+/g, '')
  const grams = new Map()
  if (stripped.length < n) return grams
  for (let i = 0; i <= stripped.length - n; i++) {
    const g = stripped.slice(i, i + n)
    grams.set(g, (grams.get(g) || 0) + 1)
  }
  return grams
}

/**
 * Word n-gram frequency map. Words are whitespace-separated tokens.
 * Used for the "++" (word-level) component of chrF++.
 *
 * @param {string} text - whitespace-cleaned input
 * @param {number} n    - n-gram order
 * @returns {Map<string, number>}
 */
function _extractWordNgrams (text, n) {
  const words = text.split(/\s+/).filter(Boolean)
  const grams = new Map()
  if (words.length < n) return grams
  for (let i = 0; i <= words.length - n; i++) {
    const g = words.slice(i, i + n).join(' ')
    grams.set(g, (grams.get(g) || 0) + 1)
  }
  return grams
}

/**
 * Precision and recall for a pair of n-gram frequency maps.
 * Returns null if either side has no n-grams (order skipped in averaging).
 *
 * @returns {{p: number, r: number}|null}
 */
function _computePR (hGrams, rGrams) {
  let hTotal = 0
  for (const c of hGrams.values()) hTotal += c
  let rTotal = 0
  for (const c of rGrams.values()) rTotal += c
  if (hTotal === 0 || rTotal === 0) return null

  let matches = 0
  for (const [g, hc] of hGrams) {
    const rc = rGrams.get(g)
    if (rc !== undefined) matches += Math.min(hc, rc)
  }
  return { p: matches / hTotal, r: matches / rTotal }
}

// ---------------------------------------------------------------------------
// chrF++ — character + word n-gram F-score (sacrebleu-compatible)
// ---------------------------------------------------------------------------

/**
 * chrF++ — character n-gram F-score augmented with word n-grams.
 *
 * Matches sacrebleu's `chrF --chrf-word-order 2` (Popović 2017).
 * Extracts character n-grams for n=1..charOrder (default 6) AND word
 * n-grams for n=1..wordOrder (default 2). Precision and recall are
 * averaged across all n-gram orders together, then combined into
 * F-beta with beta=2.
 *
 * Passing `{wordOrder: 0}` degrades gracefully to plain chrF-2.
 *
 * @param {string} hypothesis
 * @param {string} reference
 * @param {Object} [opts]
 * @param {number}  [opts.beta=2]           recall weight
 * @param {number}  [opts.charOrder=6]      max character n-gram order
 * @param {number}  [opts.wordOrder=2]      max word n-gram order (0 → chrF-2)
 * @param {boolean} [opts.caseSensitive=true]
 * @returns {number} chrF++ score in [0, 1]
 */
function chrfpp (hypothesis, reference, opts) {
  const beta = (opts && typeof opts.beta === 'number') ? opts.beta : 2
  const charOrder = (opts && typeof opts.charOrder === 'number') ? opts.charOrder : 6
  const wordOrder = (opts && typeof opts.wordOrder === 'number') ? opts.wordOrder : 2
  const caseSensitive = (opts && typeof opts.caseSensitive === 'boolean') ? opts.caseSensitive : true

  let h = _cleanWhitespace(hypothesis)
  let r = _cleanWhitespace(reference)
  if (!caseSensitive) {
    h = h.toLowerCase()
    r = r.toLowerCase()
  }
  if (h.length === 0 || r.length === 0) return 0

  let precSum = 0
  let recSum = 0
  let validOrders = 0

  for (let n = 1; n <= charOrder; n++) {
    const res = _computePR(_extractCharNgrams(h, n), _extractCharNgrams(r, n))
    if (res) { precSum += res.p; recSum += res.r; validOrders++ }
  }

  for (let n = 1; n <= wordOrder; n++) {
    const res = _computePR(_extractWordNgrams(h, n), _extractWordNgrams(r, n))
    if (res) { precSum += res.p; recSum += res.r; validOrders++ }
  }

  if (validOrders === 0) return 0

  const avgP = precSum / validOrders
  const avgR = recSum / validOrders
  if (avgP === 0 && avgR === 0) return 0

  const b2 = beta * beta
  return (1 + b2) * avgP * avgR / (b2 * avgP + avgR)
}

// ---------------------------------------------------------------------------
// Ground truth loading
// ---------------------------------------------------------------------------

const _fixtureCache = new Map()

/**
 * Loads and caches a translation-quality fixture file.
 *
 * @param {string} fixturePath
 * @returns {Array|null}
 */
function loadTranslationFixture (fixturePath) {
  _ensureNodeDefaults()
  if (_fixtureCache.has(fixturePath)) return _fixtureCache.get(fixturePath)
  try {
    const raw = fs.readFileSync(fixturePath, 'utf-8')
    const parsed = JSON.parse(raw)
    _fixtureCache.set(fixturePath, parsed)
    return parsed
  } catch (err) {
    console.log(`[translation-quality] failed to load fixture from ${fixturePath}: ${err.message}`)
    _fixtureCache.set(fixturePath, null)
    return null
  }
}

/**
 * Looks up the ground-truth entry for a given source + language pair.
 * Case-sensitive exact match on source text and language codes.
 */
function findTranslationGroundTruth (fixturePath, source, srcLang, dstLang) {
  const fixture = loadTranslationFixture(fixturePath)
  if (!Array.isArray(fixture)) return null
  for (const entry of fixture) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.source === source && entry.src_lang === srcLang && entry.dst_lang === dstLang) {
      return entry
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Full quality evaluation
// ---------------------------------------------------------------------------

/**
 * Runs translation quality checks against a ground-truth entry.
 *
 * @param {string} hypothesis
 * @param {Object|null} groundTruthEntry - with {source, reference, src_lang, dst_lang}
 * @returns {Object|null} {source, reference, src_lang, dst_lang, chrfpp} or null
 */
function evaluateTranslationQuality (hypothesis, groundTruthEntry) {
  if (!groundTruthEntry || typeof groundTruthEntry !== 'object') return null
  const reference = groundTruthEntry.reference || ''
  return {
    source: groundTruthEntry.source || null,
    reference,
    src_lang: groundTruthEntry.src_lang || null,
    dst_lang: groundTruthEntry.dst_lang || null,
    chrfpp: round4(chrfpp(hypothesis, reference))
  }
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
  chrfpp,
  loadTranslationFixture,
  findTranslationGroundTruth,
  evaluateTranslationQuality
}
