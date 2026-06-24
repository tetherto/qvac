'use strict'

const fs = require('fs')
const { MODELS_JSON_PATH } = require('./config')
const {
  sortByName,
  isShardRecord,
  shardBaseKey,
  isTensorsTxt,
  extractModelName,
  extractModelUrl
} = require('./utils')

// ---------------------------------------------------------------------------
// Strip quantization suffixes for dedup (e.g. -f16, -q4_0, -q5_K_M)
// ---------------------------------------------------------------------------
function stripQuantSuffix (name) {
  return name.replace(/-(f16|f32|q[0-9]+_[A-Za-z0-9_]*)$/, '')
}

// ---------------------------------------------------------------------------
// Filter out Bergamot support artifacts (vocab, lex, metadata, etc.)
// Only model weights (*.alphas) need attribution, not data files.
// ---------------------------------------------------------------------------
function isModelArtifact (name) {
  return /^(vocab|lex|metadata|srcvocab|trgvocab)([.]|$)/.test(name)
}

// ---------------------------------------------------------------------------
// Load and pre-process models.prod.json
// ---------------------------------------------------------------------------
let _cachedModels = null

function loadModels () {
  if (_cachedModels) return _cachedModels

  const raw = fs.readFileSync(MODELS_JSON_PATH, 'utf8')
  const allRecords = JSON.parse(raw)

  // Filter out tensors.txt and deprecated models
  const filtered = allRecords.filter(r => !isTensorsTxt(r.source) && !r.deprecated)

  // Dedup sharded models — keep first shard as representative
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

  _cachedModels = unique
  return unique
}

// ---------------------------------------------------------------------------
// Build attribution entry from a model record
// ---------------------------------------------------------------------------
function toAttribution (record) {
  return {
    name: extractModelName(record),
    license: record.licenseId || record.license || 'Unknown',
    url: extractModelUrl(record),
    engine: record.engine || ''
  }
}

// ---------------------------------------------------------------------------
// Scan all models (for sdk / registry-client)
// ---------------------------------------------------------------------------
function scanAllModels () {
  const models = loadModels()
  const attributions = models.map(toAttribution).filter(a => !isModelArtifact(a.name))

  // Dedup by name+url (distinct models may share the same URL, e.g. EasyOCR hub)
  const seen = new Map()
  for (const attr of attributions) {
    const key = `${stripQuantSuffix(attr.name)}::${attr.url}`
    if (!seen.has(key)) {
      seen.set(key, attr)
    }
  }

  return Array.from(seen.values()).sort(sortByName)
}

// ---------------------------------------------------------------------------
// Scan models for specific engines (addon packages)
// ---------------------------------------------------------------------------
function scanModelsByEngines (engines) {
  const models = loadModels()
  const filtered = models.filter(r => engines.includes(r.engine))
  const attributions = filtered.map(toAttribution).filter(a => !isModelArtifact(a.name))

  // Dedup by name+url (distinct models may share the same URL, e.g. EasyOCR hub)
  const seen = new Map()
  for (const attr of attributions) {
    const key = `${stripQuantSuffix(attr.name)}::${attr.url}`
    if (!seen.has(key)) {
      seen.set(key, attr)
    }
  }

  return Array.from(seen.values()).sort(sortByName)
}

module.exports = {
  loadModels,
  scanAllModels,
  scanModelsByEngines
}
