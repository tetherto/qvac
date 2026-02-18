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
    return json.license?.spdx_id || json.license?.key || null
  } catch {
    return null
  }
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

module.exports = {
  collator,
  sortByName,
  sortByKey,
  fetchJSON,
  fetchText,
  ghHeaders,
  fetchGHFileContent,
  fetchGHRepoLicense,
  isShardRecord,
  shardBaseKey,
  isTensorsTxt,
  extractHfRepo,
  extractModelName,
  extractModelUrl,
  exec,
  sleep
}
