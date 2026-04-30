'use strict'

/**
 * Bergamot Model Fetcher
 *
 * Downloads Bergamot (Firefox Translations) model files from the
 * Firefox Remote Settings CDN — the same source Firefox browser uses.
 *
 * This module does NOT touch OPUS or IndicTrans models.
 */

const fs = require('bare-fs')
const path = require('bare-path')

// ============================================================================
// Firefox Remote Settings CDN
// ============================================================================

const FIREFOX_RECORDS_URL =
  'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records'
const FIREFOX_ATTACHMENT_BASE =
  'https://firefox-settings-attachments.cdn.mozilla.net'

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns expected Bergamot model filenames for a language pair.
 * CJK target languages (zh, ja, ko) use separate src/trg vocabs.
 */
function getBergamotFileNames (srcLang, dstLang) {
  const pair = `${srcLang}${dstLang}`
  const cjk = ['zh', 'ja', 'ko']
  const separateVocab = cjk.includes(dstLang) || (cjk.includes(srcLang) && dstLang === 'en' && srcLang !== 'en')

  return {
    modelName: `model.${pair}.intgemm.alphas.bin`,
    srcVocabName: separateVocab ? `srcvocab.${pair}.spm` : `vocab.${pair}.spm`,
    dstVocabName: separateVocab ? `trgvocab.${pair}.spm` : `vocab.${pair}.spm`,
    lexName: `lex.50.50.${pair}.s2t.bin`
  }
}

/**
 * Checks whether a directory already contains a valid Bergamot model
 * (at minimum an .intgemm model file and a .spm vocab file).
 */
function hasBergamotModelFiles (dir) {
  try {
    const files = fs.readdirSync(dir)
    return files.some(f => f.includes('.intgemm')) && files.some(f => f.endsWith('.spm'))
  } catch {
    return false
  }
}

// ============================================================================
// Download via Firefox Remote Settings CDN
// ============================================================================

// Minimum plausible size (bytes) for a completed Bergamot artifact.
// Real files are 800KB+ (vocab) to 30MB+ (intgemm). Anything under 1KB is
// either a stub or a truncated/failed download and should be re-fetched.
const MIN_VALID_FILE_BYTES = 1024

/**
 * Returns true if `destPath` already exists as a non-trivially-sized file.
 * Used to skip re-downloads across invocations (per pivot sub-test) and
 * across duplicate records within a single invocation (Firefox's records
 * collection has production + dev variants sharing the same filename).
 */
function _isDownloadedFile (destPath) {
  try {
    const stat = fs.statSync(destPath)
    return stat.isFile() && stat.size >= MIN_VALID_FILE_BYTES
  } catch {
    return false
  }
}

/**
 * Downloads a single file from a URL to a local path.
 * Follows redirects via bare-fetch.
 * Skips the fetch entirely if the file already exists with non-trivial size.
 */
async function downloadFile (url, destPath) {
  if (_isDownloadedFile(destPath)) {
    return fs.statSync(destPath).size
  }

  const fetch = require('bare-fetch')

  const response = await fetch(url, { redirect: 'follow', follow: 5 })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading ${url}`)
  }
  const buffer = await response.arrayBuffer()
  fs.writeFileSync(destPath, Buffer.from(buffer))
  return buffer.byteLength
}

/**
 * Downloads Bergamot model files from Mozilla's Firefox Remote Settings CDN.
 * This is the same source Firefox itself uses for translation models.
 */
async function downloadBergamotFromFirefox (srcLang, dstLang, destDir) {
  const fetch = require('bare-fetch')

  console.log(`[bergamot-fetcher] Downloading ${srcLang}-${dstLang} from Firefox Remote Settings CDN...`)

  const res = await fetch(FIREFOX_RECORDS_URL)
  if (!res.ok) throw new Error(`Failed to fetch Firefox model records: HTTP ${res.status}`)
  const body = await res.json()
  const records = body.data || []

  const pairRecords = records.filter(
    r => r.fromLang === srcLang && r.toLang === dstLang && r.attachment
  )

  if (pairRecords.length === 0) {
    throw new Error(
      `No Firefox Translations model found for ${srcLang}-${dstLang}. ` +
      'Check https://github.com/mozilla/firefox-translations-models for supported pairs.'
    )
  }

  fs.mkdirSync(destDir, { recursive: true })

  // Firefox's translations-models collection exposes multiple variants per
  // language pair (production + dev/beta), several of which share the same
  // `filename`. Without dedup we'd download (and overwrite) the same file
  // 2–3× per invocation — a real case observed on Samsung Device Farm: a
  // `runPivotBergamot` test spent 20 min redundantly re-fetching ~30MB
  // .intgemm variants and timed out. Process one filename per invocation,
  // taking the first matching record.
  const seenFilenames = new Set()
  for (const record of pairRecords) {
    const att = record.attachment
    if (!att || !att.location) continue

    const filename = record.name || att.filename || path.basename(att.location)
    if (seenFilenames.has(filename)) continue
    seenFilenames.add(filename)

    const url = `${FIREFOX_ATTACHMENT_BASE}/${att.location}`
    const dest = path.join(destDir, filename)

    if (_isDownloadedFile(dest)) {
      const existingMB = fs.statSync(dest).size / 1024 / 1024
      console.log(`[bergamot-fetcher]   ✓ ${filename} (${existingMB.toFixed(1)}MB, cached)`)
      continue
    }

    console.log(`[bergamot-fetcher]   Downloading ${filename}...`)
    const bytes = await downloadFile(url, dest)
    console.log(`[bergamot-fetcher]   ✓ ${filename} (${(bytes / 1024 / 1024).toFixed(1)}MB)`)
  }

  if (!hasBergamotModelFiles(destDir)) {
    throw new Error('Firefox CDN download incomplete — missing model or vocab files')
  }

  console.log(`[bergamot-fetcher] Firefox CDN download complete → ${destDir}`)
  return destDir
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Ensures Bergamot model files are present in destDir for a given language pair.
 *
 *   1. If model files already exist in destDir → returns immediately
 *   2. Downloads from Firefox Remote Settings CDN
 *
 * @param {string} srcLang  Source language code (e.g. 'en')
 * @param {string} dstLang  Target language code (e.g. 'it')
 * @param {string} destDir  Directory to store model files
 * @returns {Promise<string>} Resolved path to the model directory
 */
async function ensureBergamotModelFiles (srcLang, dstLang, destDir) {
  if (hasBergamotModelFiles(destDir)) {
    console.log(`[bergamot-fetcher] Model already available at ${destDir}`)
    return destDir
  }

  return await downloadBergamotFromFirefox(srcLang, dstLang, destDir)
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  getBergamotFileNames,
  hasBergamotModelFiles,
  ensureBergamotModelFiles,
  downloadBergamotFromFirefox
}
