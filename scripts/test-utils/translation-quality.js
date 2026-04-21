'use strict'

/**
 * Translation quality metrics for NMT output validation.
 *
 * Computes chrF-2 (character n-gram F-score with beta=2, SacreBLEU default)
 * by comparing a translation hypothesis against a ground truth reference.
 *
 * Ground truth fixtures are JSON arrays of entries keyed by
 * { source, src_lang, dst_lang } so a single fixture can serve multiple
 * translation calls in the same test file.
 *
 * Scores are returned in the [0, 1] range to match the CER/WER convention
 * used by scripts/test-utils/quality-metrics.js (multiply by 100 at the
 * display layer if a percentage is desired).
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
 * Accepts the same `{fs, path}` shape as quality-metrics.js for consistency,
 * though only `fs` is currently used — fixture paths are passed in by the
 * caller already fully resolved (no directory lookup needed).
 *
 * @param {Object} mods
 * @param {Object} mods.fs   - bare-fs or Node fs
 * @param {Object} [mods.path] - bare-path or Node path (accepted for parity, unused)
 */
function configure (mods) {
  fs = mods.fs
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

// ---------------------------------------------------------------------------
// chrF-2: character n-gram F-score (SacreBLEU-compatible defaults)
// ---------------------------------------------------------------------------

/**
 * Extracts a character n-gram frequency map from a string.
 * Whitespace is stripped before extraction, matching the standard
 * SacreBLEU chrF behaviour (whitespace-independent n-grams).
 *
 * @param {string} text - already-normalized input string
 * @param {number} n    - n-gram size (1..6 for chrF-2)
 * @returns {Map<string, number>} gram → count
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
 * chrF-2 — character n-gram F-score with beta=2 (SacreBLEU default).
 *
 * Computes precision and recall over character n-grams for n=1..maxN,
 * averages each uniformly across n, then combines into an F-beta score
 * with beta=2 (recall weighted 2x precision).
 *
 * Operates on normalized strings; whitespace is ignored when extracting
 * n-grams. Returns a score in [0, 1], where 1 is a perfect match.
 * Returns 0 if either input is empty after normalization.
 *
 * @param {string} hypothesis - the translation output to evaluate
 * @param {string} reference  - the ground truth translation
 * @param {Object} [opts]
 * @param {number} [opts.beta=2] - recall weight (2 for chrF-2)
 * @param {number} [opts.maxN=6] - maximum n-gram order
 * @returns {number} chrF-2 score in [0, 1]
 */
function chrf (hypothesis, reference, opts) {
  const beta = (opts && typeof opts.beta === 'number') ? opts.beta : 2
  const maxN = (opts && typeof opts.maxN === 'number') ? opts.maxN : 6

  const h = normalize(hypothesis)
  const r = normalize(reference)
  if (h.length === 0 || r.length === 0) return 0

  let precSum = 0
  let recSum = 0
  let validOrders = 0

  for (let n = 1; n <= maxN; n++) {
    const hGrams = _extractCharNgrams(h, n)
    const rGrams = _extractCharNgrams(r, n)

    let hTotal = 0
    for (const c of hGrams.values()) hTotal += c
    let rTotal = 0
    for (const c of rGrams.values()) rTotal += c

    // Skip n-gram orders where either side has no n-grams (e.g. very
    // short strings). This matches sacrebleu's behaviour of averaging
    // only over n-orders that are actually defined for the pair.
    if (hTotal === 0 || rTotal === 0) continue

    let matches = 0
    for (const [g, hc] of hGrams) {
      const rc = rGrams.get(g)
      if (rc !== undefined) matches += Math.min(hc, rc)
    }

    precSum += matches / hTotal
    recSum += matches / rTotal
    validOrders++
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
 * @param {string} fixturePath - Absolute or relative path to the .json file
 * @returns {Array|null} Parsed fixture array or null on failure
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
 * Uses case-sensitive exact match on source text and language codes.
 *
 * @param {string} fixturePath - Path to the fixture JSON file
 * @param {string} source      - Source text that was translated
 * @param {string} srcLang     - Source language code (matches entry.src_lang)
 * @param {string} dstLang     - Destination language code (matches entry.dst_lang)
 * @returns {Object|null} Fixture entry or null if not found
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
 * @param {string} hypothesis - The translation output produced by the model
 * @param {Object|null} groundTruthEntry - Entry from the fixture file
 *   (with `source`, `reference`, `src_lang`, `dst_lang` fields)
 * @returns {Object|null} Quality result, or null if groundTruthEntry is null
 */
function evaluateTranslationQuality (hypothesis, groundTruthEntry) {
  if (!groundTruthEntry || typeof groundTruthEntry !== 'object') return null
  const reference = groundTruthEntry.reference || ''
  return {
    source: groundTruthEntry.source || null,
    reference,
    src_lang: groundTruthEntry.src_lang || null,
    dst_lang: groundTruthEntry.dst_lang || null,
    chrf: round4(chrf(hypothesis, reference))
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
  chrf,
  loadTranslationFixture,
  findTranslationGroundTruth,
  evaluateTranslationQuality
}
