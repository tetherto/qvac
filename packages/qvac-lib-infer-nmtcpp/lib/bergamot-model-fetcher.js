'use strict'

/**
 * Bergamot Model Fetcher
 *
 * Downloads Bergamot (Firefox Translations) model files using:
 *   1. Hyperdrive keys (primary) — from the Model Registry in README.md
 *   2. Firefox Remote Settings CDN (fallback) — same source Firefox browser uses
 *
 * This module does NOT touch OPUS or IndicTrans models.
 */

const fs = require('bare-fs')
const path = require('bare-path')

// ============================================================================
// Bergamot Hyperdrive Keys (from README.md Model Registry)
// Key = language-pair code (e.g. 'enit'), Value = Hyperdrive hex key
// ============================================================================

const BERGAMOT_HYPERDRIVE_KEYS = {
  aren: '152125b9e579de7897bffddc2756a712f1c8e6fcbda162d1a821aab135c8ad7e',
  csen: '41df2dadab7db9a8258d1520ae5815601f5690e0d96ab1e61f931427a679d32d',
  enar: 'c9ae647365e18d8c51eb21c47721544ee3daaaec375913e5ccb7a8d11d493a0c',
  encs: 'c7ccfc55618925351f32b00265375c66309240af9e90f0baf7f460ebc5ba34de',
  enes: 'bf46f9b51d04f5619eea1988499d81cd65268d9b0a60bea0fb647859ffe98a3c',
  enfr: '0a4f388c0449b7774043e5ba8a1a2f735dc22a0a8e01d8bcd593e28db2909abf',
  enit: 'a8811fb494e4aee45ca06a011703a25df5275e5dfa59d6217f2d430c677f9fa6',
  enja: 'ac0b883d176ea3b1d304790efe2d4e4e640a474b7796244c92496fb9d660f29d',
  enpt: '21f12262b8b0440b814f2e57e8224d0921c6cf09e1da0238a4e83789b57ab34f',
  enru: '404279d9716f31913cdb385bef81e940019134b577ed64ae3333b80da75a80bf',
  enzh: '15d484200acea8b19b7eeffd5a96b218c3c437afbed61bfef39dafbae6edfec0',
  esen: 'c3e983c8db3f64faeef8eaf1da9ea4aeb8d5c020529f83957d63c19ed7710651',
  fren: '7a9b38b0c4637b2eab9c11387b8c3f254db64da47cc5a7eecda66513176f7757',
  iten: '3b4be93d19dd9e9e6ee38b528684028ac03c7776563bc0e5ca668b76b0964480',
  jaen: '85012ed3c3ff5c2bfe49faa60ebafb86306e6f2a97f49796374d3069f505bfd3',
  pten: 'a5da4ee5f5817033dee6ed4489d1d3cadcf3d61e99fd246da7e0143c4b7439a4',
  ruen: 'dad7f99c8d8c17233bcfa005f789a0df29bb4ae3116381bdb2a63ffc32c97dfe',
  zhen: '17eb4c3fcd23ac3c93cbe62f08ecb81d70f561f563870ea42494214d6886dd66'
}

// ============================================================================
// Firefox Remote Settings (fallback download source)
// ============================================================================

const FIREFOX_RECORDS_URL =
  'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records'
const FIREFOX_ATTACHMENT_BASE =
  'https://firefox-settings-attachments.cdn.mozilla.net'

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns the Hyperdrive hex key for a Bergamot language pair, or null.
 * @param {string} srcLang - e.g. 'en'
 * @param {string} dstLang - e.g. 'it'
 * @returns {string|null}
 */
function getBergamotHyperdriveKey (srcLang, dstLang) {
  return BERGAMOT_HYPERDRIVE_KEYS[`${srcLang}${dstLang}`] || null
}

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
// Download via Hyperdrive
// ============================================================================

/**
 * Downloads Bergamot model files from Hyperdrive into destDir.
 * Resolves to destDir on success, or throws on failure.
 */
async function downloadBergamotFromHyperdrive (srcLang, dstLang, destDir) {
  const key = getBergamotHyperdriveKey(srcLang, dstLang)
  if (!key) throw new Error(`No Hyperdrive key for Bergamot ${srcLang}-${dstLang}`)

  const HyperdriveDL = require('@qvac/dl-hyperdrive')
  const fileNames = getBergamotFileNames(srcLang, dstLang)

  console.log(`[bergamot-fetcher] Downloading ${srcLang}-${dstLang} from Hyperdrive (${key.substring(0, 12)}...)`)

  const hdDL = new HyperdriveDL({ key: `hd://${key}` })
  fs.mkdirSync(destDir, { recursive: true })

  try {
    await hdDL.ready()

    for (const filename of Object.values(fileNames)) {
      try {
        const data = await hdDL.download(filename)
        if (data && data.length > 0) {
          fs.writeFileSync(path.join(destDir, filename), data)
          console.log(`[bergamot-fetcher]   ✓ ${filename} (${(data.length / 1024 / 1024).toFixed(1)}MB)`)
        }
      } catch (e) {
        // lex file is optional for some pairs — don't fail
        if (filename.startsWith('lex.')) {
          console.log(`[bergamot-fetcher]   ⚠ ${filename} not available (optional)`)
        } else {
          throw e
        }
      }
    }
  } finally {
    try { await hdDL.close() } catch { /* ignore */ }
  }

  if (!hasBergamotModelFiles(destDir)) {
    throw new Error('Hyperdrive download incomplete — missing model or vocab files')
  }

  console.log(`[bergamot-fetcher] Hyperdrive download complete → ${destDir}`)
  return destDir
}

// ============================================================================
// Download via Firefox Remote Settings CDN (fallback)
// ============================================================================

/**
 * Downloads a single file from a URL to a local path.
 * Follows redirects via bare-fetch.
 */
async function downloadFile (url, destPath) {
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

  // 1. Fetch the model records index
  const res = await fetch(FIREFOX_RECORDS_URL)
  if (!res.ok) throw new Error(`Failed to fetch Firefox model records: HTTP ${res.status}`)
  const body = await res.json()
  const records = body.data || []

  // 2. Filter records for this language pair (model, vocab, lex files)
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

  // 3. Download each file
  for (const record of pairRecords) {
    const att = record.attachment
    if (!att || !att.location) continue

    const filename = record.name || att.filename || path.basename(att.location)
    const url = `${FIREFOX_ATTACHMENT_BASE}/${att.location}`
    const dest = path.join(destDir, filename)

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
 *   2. Try downloading from Hyperdrive (if key available)
 *   3. Fall back to downloading from Firefox Remote Settings CDN
 *
 * @param {string} srcLang  Source language code (e.g. 'en')
 * @param {string} dstLang  Target language code (e.g. 'it')
 * @param {string} destDir  Directory to store model files
 * @returns {Promise<string>} Resolved path to the model directory
 */
async function ensureBergamotModelFiles (srcLang, dstLang, destDir) {
  // Already present?
  if (hasBergamotModelFiles(destDir)) {
    console.log(`[bergamot-fetcher] Model already available at ${destDir}`)
    return destDir
  }

  // Try Hyperdrive first
  const hdKey = getBergamotHyperdriveKey(srcLang, dstLang)
  if (hdKey) {
    try {
      return await downloadBergamotFromHyperdrive(srcLang, dstLang, destDir)
    } catch (e) {
      console.log(`[bergamot-fetcher] Hyperdrive failed: ${e.message}`)
      console.log('[bergamot-fetcher] Falling back to Firefox CDN...')
    }
  } else {
    console.log(`[bergamot-fetcher] No Hyperdrive key for ${srcLang}-${dstLang}, using Firefox CDN`)
  }

  // Fallback: Firefox Remote Settings CDN
  return await downloadBergamotFromFirefox(srcLang, dstLang, destDir)
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  BERGAMOT_HYPERDRIVE_KEYS,
  getBergamotHyperdriveKey,
  getBergamotFileNames,
  hasBergamotModelFiles,
  ensureBergamotModelFiles,
  downloadBergamotFromHyperdrive,
  downloadBergamotFromFirefox
}
