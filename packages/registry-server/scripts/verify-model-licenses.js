#!/usr/bin/env node

'use strict'

const path = require('path')
const fs = require('fs')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const HF_TOKEN = process.env.HF_TOKEN
const GH_TOKEN = process.env.GH_TOKEN
const MODELS_PATH = path.join(
  __dirname,
  '..', 'data', 'models.prod.json'
)
const REQUEST_DELAY_MS = 120 // throttle between API calls
const FETCH_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Known non-HF / non-GH fallback mappings
// (link domain -> GitHub repo for license lookup)
// ---------------------------------------------------------------------------
const LINK_TO_GH_REPO = {
  'jaided.ai': 'JaidedAI/EasyOCR',
  'voiceinput.futo.org': 'futo-org/futo-whisper-tiny-en' // HF repo actually
}

// ---------------------------------------------------------------------------
// HF repos to skip license verification (no license metadata on HF)
// ---------------------------------------------------------------------------
const SKIP_HF_REPOS = new Set([
  'futo-org/futo-whisper-tiny-en',
  'JaepaX/whisper-tiny-es',
  'DavyCosta701/whisper-tiny-pt-bpra',
  'aware-ai/whisper-base-german',
  'gustavv-andrzejewski/distil-whisper-base-it',
  'yaroslav0530/whisper-tiny-ru'
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractHfRepo (url) {
  if (!url) return null
  const m = url.match(/huggingface\.co\/([^/]+\/[^/]+)/)
  return m ? m[1] : null
}

function extractGhRepo (url) {
  if (!url) return null
  const m = url.match(/github\.com\/([^/]+\/[^/]+)/)
  return m ? m[1] : null
}

function getLinkDomain (url) {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function isShardRecord (source) {
  return /-\d{5}-of-\d{5}/.test(source || '')
}

function shardBaseKey (source) {
  return (source || '').replace(/-\d{5}-of-\d{5}/, '')
}

function isTensorsTxt (source) {
  return (source || '').endsWith('.tensors.txt')
}

// ---------------------------------------------------------------------------
// API fetchers (with cache)
// ---------------------------------------------------------------------------
const hfCache = new Map()
const ghCache = new Map()

async function fetchWithTimeout (url, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal })
    return res
  } finally {
    clearTimeout(timer)
  }
}

async function fetchHfLicense (repo) {
  if (hfCache.has(repo)) return hfCache.get(repo)

  const url = `https://huggingface.co/api/models/${repo}`
  const headers = {}
  if (HF_TOKEN) headers.Authorization = `Bearer ${HF_TOKEN}`

  try {
    await sleep(REQUEST_DELAY_MS)
    const res = await fetchWithTimeout(url, { headers })
    if (!res.ok) {
      const result = { license: null, error: `HTTP ${res.status}` }
      hfCache.set(repo, result)
      return result
    }
    const json = await res.json()
    let license = json.cardData?.license || null
    if ((!license || license === 'other') && json.cardData?.license_name) {
      license = json.cardData.license_name
    }
    if (!license && Array.isArray(json.tags)) {
      const tag = json.tags.find((t) => t.startsWith('license:'))
      if (tag) license = tag.replace('license:', '')
    }
    const result = { license, error: null }
    hfCache.set(repo, result)
    return result
  } catch (err) {
    const result = { license: null, error: err.message }
    hfCache.set(repo, result)
    return result
  }
}

async function fetchGhLicense (repo) {
  if (ghCache.has(repo)) return ghCache.get(repo)

  const url = `https://api.github.com/repos/${repo}/license`
  const headers = { Accept: 'application/vnd.github.v3+json' }
  if (GH_TOKEN) headers.Authorization = `token ${GH_TOKEN}`

  try {
    await sleep(REQUEST_DELAY_MS)
    const res = await fetchWithTimeout(url, { headers })
    if (!res.ok) {
      const result = { license: null, error: `HTTP ${res.status}` }
      ghCache.set(repo, result)
      return result
    }
    const json = await res.json()
    const license = json.license?.spdx_id || json.license?.key || null
    const result = { license, error: null }
    ghCache.set(repo, result)
    return result
  } catch (err) {
    const result = { license: null, error: err.message }
    ghCache.set(repo, result)
    return result
  }
}

// ---------------------------------------------------------------------------
// Classify a record and resolve the API to use
// ---------------------------------------------------------------------------
function classifyRecord (record) {
  const { source, link } = record
  const isS3 = (source || '').startsWith('s3://')

  const hfFromSource = extractHfRepo(source)
  if (hfFromSource) {
    return { type: 'hf', repo: hfFromSource }
  }

  if (isS3 && link) {
    const hfFromLink = extractHfRepo(link)
    if (hfFromLink) {
      return { type: 'hf', repo: hfFromLink }
    }

    const ghFromLink = extractGhRepo(link)
    if (ghFromLink) {
      return { type: 'gh', repo: ghFromLink }
    }

    const domain = getLinkDomain(link)
    if (domain && LINK_TO_GH_REPO[domain]) {
      const fallbackRepo = LINK_TO_GH_REPO[domain]
      if (fallbackRepo.includes('/')) {
        if (domain === 'voiceinput.futo.org') {
          return { type: 'hf', repo: fallbackRepo }
        }
        return { type: 'gh', repo: fallbackRepo }
      }
    }

    return { type: 'no_api', link }
  }

  return { type: 'no_api', link: link || source }
}

// ---------------------------------------------------------------------------
// Normalize license strings for comparison
// ---------------------------------------------------------------------------
function normalizeLicense (license) {
  if (!license) return ''
  return license.toLowerCase().replace(/[^a-z0-9.-]/g, '')
}

function licensesMatch (existing, fetched) {
  if (!fetched) return false
  const a = normalizeLicense(existing)
  const b = normalizeLicense(fetched)
  if (a === b) return true
  const aliases = {
    'apache-2.0': ['apache2.0', 'apache20', 'apache-2.0'],
    mit: ['mit'],
    'llama3.2': ['llama3.2', 'llama-3.2'],
    gemma: ['gemma'],
    'qwen-research': ['qwen-research', 'qwen'],
    'health-ai-developer-foundations': ['health-ai-developer-foundations']
  }
  for (const [, variants] of Object.entries(aliases)) {
    const normVariants = variants.map(normalizeLicense)
    if (normVariants.includes(a) && normVariants.includes(b)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main () {
  if (!HF_TOKEN) {
    console.error('HF_TOKEN is required. Run: source .env')
    process.exit(1)
  }

  // Load data
  const raw = fs.readFileSync(MODELS_PATH, 'utf8')
  const allRecords = JSON.parse(raw)

  // Step 1: Filter out tensors.txt
  const filtered = allRecords.filter((r) => !isTensorsTxt(r.source))

  // Step 2: Dedup sharded models - keep first shard as representative
  const seenShardBases = new Set()
  const unique = []
  for (const record of filtered) {
    if (isShardRecord(record.source)) {
      const base = shardBaseKey(record.source)
      if (seenShardBases.has(base)) continue
      seenShardBases.add(base)
    }
    unique.push(record)
  }

  console.log(`Total records: ${allRecords.length}`)
  console.log(`After filtering tensors.txt: ${filtered.length}`)
  console.log(`After dedup shards: ${unique.length}`)
  console.log()

  // Step 3: Fetch licenses and build results
  const results = []
  const failures = []
  let processed = 0

  for (const record of unique) {
    processed++
    const classification = classifyRecord(record)
    const tags = (record.tags || []).join(',')
    const engine = record.engine || 'unknown'
    const existingLicense = (record.license || '').toLowerCase()

    const entry = {
      engine,
      tags,
      existingLicense,
      source: record.source,
      link: record.link || '',
      fetchedLicense: null,
      fetchSource: null,
      status: null,
      detail: null
    }

    if (classification.type === 'hf' && SKIP_HF_REPOS.has(classification.repo)) {
      process.stderr.write(
        `\r[${processed}/${unique.length}] SKIP: ${classification.repo}     `
      )
      entry.fetchSource = `HF: ${classification.repo}`
      entry.status = 'SKIPPED'
      entry.detail = 'No license metadata on HF, manually verified'
      results.push(entry)
      continue
    }

    if (classification.type === 'hf') {
      process.stderr.write(
        `\r[${processed}/${unique.length}] HF: ${classification.repo}     `
      )
      const result = await fetchHfLicense(classification.repo)
      entry.fetchSource = `HF: ${classification.repo}`

      if (result.error) {
        entry.status = 'FETCH_ERROR'
        entry.detail = result.error
        failures.push(entry)
      } else if (!result.license) {
        entry.status = 'EMPTY_LICENSE'
        entry.detail = 'API returned empty license'
        failures.push(entry)
      } else {
        entry.fetchedLicense = result.license
        if (licensesMatch(existingLicense, result.license)) {
          entry.status = 'OK'
        } else {
          entry.status = 'MISMATCH'
          entry.detail = `existing="${existingLicense}" fetched="${result.license}"`
          failures.push(entry)
        }
      }
    } else if (classification.type === 'gh') {
      process.stderr.write(
        `\r[${processed}/${unique.length}] GH: ${classification.repo}     `
      )
      const result = await fetchGhLicense(classification.repo)
      entry.fetchSource = `GH: ${classification.repo}`

      if (result.error) {
        entry.status = 'FETCH_ERROR'
        entry.detail = result.error
        failures.push(entry)
      } else if (!result.license) {
        entry.status = 'EMPTY_LICENSE'
        entry.detail = 'API returned empty license'
        failures.push(entry)
      } else {
        entry.fetchedLicense = result.license
        if (licensesMatch(existingLicense, result.license)) {
          entry.status = 'OK'
        } else {
          entry.status = 'MISMATCH'
          entry.detail = `existing="${existingLicense}" fetched="${result.license}"`
          failures.push(entry)
        }
      }
    } else {
      process.stderr.write(
        `\r[${processed}/${unique.length}] NO_API: ${classification.link || 'n/a'}     `
      )
      entry.fetchSource = classification.link || 'n/a'
      entry.status = 'NO_API'
      entry.detail = 'No HF or GitHub API available for this source'
      failures.push(entry)
    }

    results.push(entry)
  }

  process.stderr.write('\r' + ' '.repeat(80) + '\r')

  // ----- Print report to console -----
  const okCount = results.filter((r) => r.status === 'OK').length
  const mismatchCount = results.filter((r) => r.status === 'MISMATCH').length
  const errorCount = results.filter((r) => r.status === 'FETCH_ERROR').length
  const emptyCount = results.filter((r) => r.status === 'EMPTY_LICENSE').length
  const noApiCount = results.filter((r) => r.status === 'NO_API').length
  const skippedCount = results.filter((r) => r.status === 'SKIPPED').length

  // License summary
  const licenseCounts = {}
  for (const entry of results) {
    const lic = (entry.existingLicense || 'UNKNOWN').toLowerCase()
    licenseCounts[lic] = (licenseCounts[lic] || 0) + 1
  }

  console.log('=== LICENSE SUMMARY (unique models) ===')
  console.log()
  const sorted = Object.entries(licenseCounts).sort((a, b) => b[1] - a[1])
  const maxLicLen = Math.max(...sorted.map(([l]) => l.length))
  for (const [license, count] of sorted) {
    console.log(`  ${license.padEnd(maxLicLen)} = ${count}`)
  }
  console.log()

  // Full model list
  console.log('=== MODEL LIST ===')
  console.log()

  const maxEngineLen = Math.max(...results.map((r) => r.engine.length))
  const maxTagsLen = Math.max(...results.map((r) => r.tags.length))
  const maxExistingLen = Math.max(...results.map((r) => r.existingLicense.length))

  for (const entry of results) {
    const fetchedPart = entry.fetchedLicense
      ? `(${entry.fetchSource}: ${entry.fetchedLicense})`
      : entry.fetchSource
        ? `(${entry.fetchSource})`
        : ''

    console.log(
      `  ${entry.engine.padEnd(maxEngineLen)} | ` +
        `${entry.tags.padEnd(maxTagsLen)} | ` +
        `${entry.existingLicense.padEnd(maxExistingLen)} | ` +
        `${fetchedPart} ${entry.status}`
    )
  }
  console.log()

  // Failures
  console.log('=== UNVERIFIED / FETCH FAILURES ===')
  console.log()

  if (failures.length === 0) {
    console.log('  (none)')
  } else {
    const maxReasonLen = Math.max(...failures.map((f) => f.status.length))
    const maxFEngineLen = Math.max(...failures.map((f) => f.engine.length))
    const maxFTagsLen = Math.max(...failures.map((f) => f.tags.length))
    const maxFLicLen = Math.max(...failures.map((f) => f.existingLicense.length))

    for (const entry of failures) {
      console.log(
        `  ${entry.status.padEnd(maxReasonLen)} | ` +
          `${entry.engine.padEnd(maxFEngineLen)} | ` +
          `${entry.tags.padEnd(maxFTagsLen)} | ` +
          `${entry.existingLicense.padEnd(maxFLicLen)} | ` +
          `${entry.fetchSource || 'n/a'} | ` +
          `${entry.detail || ''}`
      )
    }
  }
  console.log()

  // Stats
  console.log('=== STATS ===')
  console.log()
  console.log(`  Verified OK     : ${okCount}`)
  console.log(`  Mismatch        : ${mismatchCount}`)
  console.log(`  Fetch errors    : ${errorCount}`)
  console.log(`  Empty license   : ${emptyCount}`)
  console.log(`  No API available: ${noApiCount}`)
  console.log(`  Skipped         : ${skippedCount}`)
  console.log(`  Total unique    : ${results.length}`)
  console.log()

  // Exit code — fail if any model could not be verified
  if (mismatchCount > 0 || errorCount > 0 || emptyCount > 0) {
    console.error(
      `FAILED: ${mismatchCount} mismatch(es), ${errorCount} fetch error(s), ${emptyCount} empty license(s)`
    )
    process.exit(1)
  }

  console.log('All verifiable models passed license check.')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(2)
})
