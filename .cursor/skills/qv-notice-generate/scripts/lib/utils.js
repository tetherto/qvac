'use strict'

const { execSync } = require('child_process')

// ---------------------------------------------------------------------------
// Deterministic collator for sorting — always produces the same order
// ---------------------------------------------------------------------------
const collator = new Intl.Collator('en', { sensitivity: 'base' })

function sortByName (a, b) {
  return collator.compare(a.name, b.name)
}

function sortByKey (key) {
  return (a, b) => collator.compare(a[key], b[key])
}

// ---------------------------------------------------------------------------
// HTTP fetch with timeout and optional auth
// ---------------------------------------------------------------------------
const FETCH_TIMEOUT_MS = 15_000

async function fetchJSON (url, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchText (url, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`)
    }
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------
function ghHeaders () {
  const token = process.env.GH_TOKEN
  const headers = { Accept: 'application/vnd.github.v3+json' }
  if (token) {
    // Bearer works for classic PATs, fine-grained PATs, and app tokens
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

async function fetchGHFileContent (repo, filePath, ref) {
  // Use the Contents API (works for private repos with token auth)
  const url = `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${ref}`
  const headers = ghHeaders()
  headers.Accept = 'application/vnd.github.v3.raw'
  return fetchText(url, { headers })
}

async function fetchGHRepoLicense (repo) {
  const url = `https://api.github.com/repos/${repo}/license`
  try {
    const json = await fetchJSON(url, { headers: ghHeaders() })
    const spdx = json.license?.spdx_id || json.license?.key || null
    if (spdx && spdx !== 'NOASSERTION') return spdx

    // GitHub couldn't detect — try reading LICENSE files directly
    const licenseFiles = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md']
    for (const f of licenseFiles) {
      try {
        const headers = ghHeaders()
        headers.Accept = 'application/vnd.github.v3.raw'
        const content = await fetchText(
          `https://api.github.com/repos/${repo}/contents/${f}`,
          { headers }
        )
        const detected = detectLicenseFromContent(content)
        if (detected) return detected
      } catch { /* file doesn't exist, try next */ }
    }

    return spdx // return NOASSERTION if nothing matched
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Detect license SPDX from file content (simple keyword matching)
// ---------------------------------------------------------------------------
function detectLicenseFromContent (text) {
  if (!text) return null
  const lower = text.toLowerCase()

  // Check for dual/multi-license files — look for the primary code license
  // Match patterns like "the C++ code ... Apache 2.0" or "source code ... Apache"
  const codeApache = /(?:c\+\+|source|code)[^.]*apache(?:\s+license)?(?:,?\s*version)?\s*2/i
  if (codeApache.test(text)) return 'Apache-2.0'

  // Single-license detection (order: most specific first)
  if (lower.includes('apache license') && lower.includes('version 2.0')) return 'Apache-2.0'
  if (lower.includes('apache-2.0')) return 'Apache-2.0'
  if (lower.includes('mit license') || /permission is hereby granted, free of charge/i.test(text)) return 'MIT'
  if (lower.includes('mozilla public license version 2.0') || lower.includes('mpl-2.0')) return 'MPL-2.0'
  if (lower.includes('bsd 3-clause') || lower.includes('bsd-3-clause')) return 'BSD-3-Clause'
  if (lower.includes('bsd 2-clause') || lower.includes('bsd-2-clause')) return 'BSD-2-Clause'
  if (lower.includes('gnu lesser general public license') && lower.includes('version 2.1')) return 'LGPL-2.1'
  if (lower.includes('gnu general public license') && lower.includes('version 3')) return 'GPL-3.0'
  if (lower.includes('gnu general public license') && lower.includes('version 2')) return 'GPL-2.0'
  if (lower.includes('isc license')) return 'ISC'

  return null
}

// ---------------------------------------------------------------------------
// Dedup sharded models
// ---------------------------------------------------------------------------
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
// Extract HF repo from URL
// ---------------------------------------------------------------------------
function extractHfRepo (url) {
  if (!url) return null
  const m = url.match(/huggingface\.co\/([^/]+\/[^/]+)/)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Extract model display name from source URL or tags
// ---------------------------------------------------------------------------
function extractModelName (record) {
  const { source, tags } = record

  // Try to get a meaningful name from the HF URL path
  const hfRepo = extractHfRepo(source)
  if (hfRepo) {
    // Use the repo name (org/model) as display name
    return hfRepo.split('/').pop()
  }

  // For S3 sources, try to extract filename
  if (source && source.startsWith('s3://')) {
    const parts = source.split('/')
    const filename = parts[parts.length - 1]
    if (filename) {
      return filename.replace(/\.[^.]+$/, '') // strip extension
    }
  }

  // Fall back to tags
  if (tags && tags.length > 0) {
    return tags.filter(t => !['shard'].includes(t)).join('-')
  }

  return source || 'unknown'
}

// ---------------------------------------------------------------------------
// Extract attribution URL from a model record
// ---------------------------------------------------------------------------
function extractModelUrl (record) {
  const { source, link } = record

  // If source is a HF URL, use it (strip /blob/ to get the repo page)
  if (source && source.includes('huggingface.co')) {
    const hfRepo = extractHfRepo(source)
    if (hfRepo) return `https://huggingface.co/${hfRepo}`
  }

  // Otherwise use the link property
  if (link) {
    // If link is HF, use the repo page
    const hfRepo = extractHfRepo(link)
    if (hfRepo) return `https://huggingface.co/${hfRepo}`
    return link
  }

  return source || ''
}

// ---------------------------------------------------------------------------
// Shell exec helper
// ---------------------------------------------------------------------------
function exec (cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts })
}

// ---------------------------------------------------------------------------
// Throttle helper for API calls
// ---------------------------------------------------------------------------
function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Fetch license from PyPI JSON API
// Tries: info.license field, then classifiers
// ---------------------------------------------------------------------------
async function fetchPyPILicense (packageName) {
  try {
    const data = await fetchJSON(`https://pypi.org/pypi/${packageName}/json`)
    const info = data.info || {}

    // 1. Check info.license field directly
    if (info.license && info.license !== 'UNKNOWN' && info.license.length < 100) {
      return { license: info.license, url: info.home_page || info.project_url || '' }
    }

    // 2. Check classifiers for license
    const classifiers = info.classifiers || []
    for (const c of classifiers) {
      // e.g. "License :: OSI Approved :: Apache Software License"
      const match = c.match(/^License :: (?:OSI Approved :: )?(.+)$/)
      if (match) {
        return { license: match[1], url: info.home_page || info.project_url || '' }
      }
    }

    // 3. Check project_urls for a GitHub repo and try GitHub API
    const urls = info.project_urls || {}
    const url = urls.Homepage || urls.Repository || urls.Source || urls.homepage || urls.repository || info.home_page || ''

    if (url && url.includes('github.com')) {
      const ghMatch = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\/|$)/)
      if (ghMatch) {
        const ghLicense = await fetchGHRepoLicense(ghMatch[1])
        if (ghLicense && ghLicense !== 'NOASSERTION') {
          return { license: ghLicense, url }
        }
      }
    }

    return { license: null, url }
  } catch {
    return { license: null, url: '' }
  }
}

module.exports = {
  collator,
  sortByName,
  sortByKey,
  fetchJSON,
  fetchText,
  ghHeaders,
  fetchGHFileContent,
  fetchGHRepoLicense,
  fetchPyPILicense,
  isShardRecord,
  shardBaseKey,
  isTensorsTxt,
  extractHfRepo,
  extractModelName,
  extractModelUrl,
  exec,
  sleep
}
