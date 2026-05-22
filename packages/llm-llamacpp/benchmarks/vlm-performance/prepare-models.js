#!/usr/bin/env node
'use strict'

// Resolves model files needed by the benchmark and writes their paths
// to resolved-models.json. Two model sources are supported:
//
//   model.candidate — always downloaded.
//   model.baseline  — downloaded only when --compare-baseline is set.
//
// Each source resolves its LLM and mmproj URLs as follows:
//   1. CLI override (--local-{candidate,baseline}-model / --mmproj)
//   2. The source's registry data file (registryDataFile +
//      registryMatcher), when the file exists in the working tree.
//   3. The source's direct URL (`url.llm`, `url.mmproj`).
//
// Output (resolved-models.json):
//   {
//     candidate: { label, llmPath, mmprojPath },
//     baseline:  { label, llmPath, mmprojPath } | null
//   }

const fs = require('fs')
const path = require('path')
const https = require('https')
const crypto = require('crypto')

const config = require('./vlm-bench.config')
const { parseArgs } = require('./utils')

const SCRIPT_DIR = __dirname
const DEFAULT_MODELS_DIR = path.join(SCRIPT_DIR, 'models')
// Repo root, used to resolve registry data file paths.
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..', '..')

function log (...args) { console.log('[prepare-models]', ...args) }

function ensureDir (dir) { fs.mkdirSync(dir, { recursive: true }) }

function downloadFile (url, destination, headers, redirects = 5) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(destination))
    const tmpPath = `${destination}.partial`
    const out = fs.createWriteStream(tmpPath)
    let settled = false
    const cleanup = () => { try { if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath) } catch {} }
    const fail = (error) => {
      if (settled) return
      settled = true
      try { out.destroy() } catch {}
      cleanup()
      reject(error)
    }
    const succeed = () => {
      if (settled) return
      settled = true
      try { fs.renameSync(tmpPath, destination); resolve() } catch (e) { reject(e) }
    }
    https.get(url, { headers }, (res) => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirects <= 0) return fail(new Error(`Too many redirects for ${url}`))
        const next = new URL(res.headers.location, url).toString()
        settled = true
        try { out.destroy() } catch {}
        cleanup()
        return resolve(downloadFile(next, destination, headers, redirects - 1))
      }
      if (status < 200 || status >= 300) {
        res.resume()
        const err = new Error(`HTTP ${status}`)
        err.code = status
        err.url = url
        return fail(err)
      }
      res.pipe(out)
      out.on('finish', () => out.close(succeed))
      res.on('error', fail)
    }).on('error', fail)
    out.on('error', (e) => fail(e))
  })
}

// Looks up the URL for a model filename inside the project's registry
// data file. Returns null when the file doesn't exist or when no entry
// matches. Match policy: substring check against the `source` field.
function lookupRegistryUrl (sourceSpec, kind) {
  const dataFile = sourceSpec.registryDataFile
  const matcher = sourceSpec.registryMatcher && sourceSpec.registryMatcher[kind]
  if (!dataFile || !matcher) return null
  const fullPath = path.resolve(REPO_ROOT, dataFile)
  if (!fs.existsSync(fullPath)) {
    log(`registry data file not found: ${fullPath} - falling back to direct URL`)
    return null
  }
  try {
    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    const list = Array.isArray(data) ? data : (Array.isArray(data.models) ? data.models : null)
    if (!list) return null
    const hit = list.find((e) => typeof e.source === 'string' && e.source.includes(matcher))
    return hit ? hit.source : null
  } catch (e) {
    log(`could not parse registry data file: ${e.message}`)
    return null
  }
}

async function resolveOnePart ({ sourceLabel, kind, sourceSpec, destination, localOverride, headers }) {
  if (localOverride) {
    if (!fs.existsSync(localOverride)) {
      throw new Error(`--${sourceLabel}-${kind} override file not found: ${localOverride}`)
    }
    log(`${sourceLabel}/${kind}: using local file ${localOverride}`)
    return path.resolve(localOverride)
  }
  if (fs.existsSync(destination)) {
    log(`${sourceLabel}/${kind}: already present -> ${destination}`)
    return destination
  }
  // Try registry-data lookup first (only when sourceSpec opts in),
  // then fall back to the direct URL in the config.
  const fromRegistry = lookupRegistryUrl(sourceSpec, kind)
  const url = fromRegistry || (sourceSpec.url && sourceSpec.url[kind])
  if (!url) {
    throw new Error(`No URL configured for ${sourceLabel}/${kind}`)
  }
  log(`${sourceLabel}/${kind}: downloading from ${url}`)
  await downloadFile(url, destination, headers)
  log(`${sourceLabel}/${kind}: downloaded -> ${destination}`)
  return destination
}

// SHA-256 of a file, used as a provenance fingerprint. We chunk-stream
// the file to avoid loading multi-GB GGUFs into memory.
function sha256OfFile (filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(filePath)
    s.on('error', reject)
    s.on('data', (c) => h.update(c))
    s.on('end', () => resolve(h.digest('hex')))
  })
}

async function provenanceFor (filePath, urlUsed) {
  if (!filePath || !fs.existsSync(filePath)) return null
  const stat = fs.statSync(filePath)
  const sha256 = await sha256OfFile(filePath)
  return {
    path: filePath,
    sizeBytes: stat.size,
    sizeMb: Math.round((stat.size / (1024 * 1024)) * 100) / 100,
    sha256,
    url: urlUsed || null
  }
}

async function resolveSource (sourceSpec, modelsDir, headers, args) {
  const label = sourceSpec.label
  const llmDest = path.join(modelsDir, sourceSpec.llmFile)
  const mmprojDest = path.join(modelsDir, sourceSpec.mmprojFile)
  const llmUrl = lookupRegistryUrl(sourceSpec, 'llm') || (sourceSpec.url && sourceSpec.url.llm)
  const mmprojUrl = lookupRegistryUrl(sourceSpec, 'mmproj') || (sourceSpec.url && sourceSpec.url.mmproj)
  const llmPath = await resolveOnePart({
    sourceLabel: label,
    kind: 'llm',
    sourceSpec,
    destination: llmDest,
    localOverride: args[`local-${label}-model`],
    headers
  })
  const mmprojPath = await resolveOnePart({
    sourceLabel: label,
    kind: 'mmproj',
    sourceSpec,
    destination: mmprojDest,
    localOverride: args[`local-${label}-mmproj`],
    headers
  })
  // Per-file provenance: byte size, SHA-256, the URL we resolved
  // from. Surfaced in the consolidated report so a reviewer can audit
  // which exact blob produced each row.
  const llmProvenance = await provenanceFor(llmPath, llmUrl)
  const mmprojProvenance = await provenanceFor(mmprojPath, mmprojUrl)
  return {
    label,
    quant: sourceSpec.quant || null,
    hfRepo: sourceSpec.hfRepo || null,
    hfRevision: sourceSpec.hfRevision || null,
    llmPath,
    mmprojPath,
    provenance: { llm: llmProvenance, mmproj: mmprojProvenance }
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const modelsDir = args['models-dir'] ? path.resolve(args['models-dir']) : DEFAULT_MODELS_DIR
  ensureDir(modelsDir)

  const headers = { 'User-Agent': 'qvac-vlm-benchmark-prep/1.0' }
  if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`

  const m = config.model
  const candidate = await resolveSource(m.candidate, modelsDir, headers, args)

  let baseline = null
  if (args['compare-baseline']) {
    baseline = await resolveSource(m.baseline, modelsDir, headers, args)
  } else {
    log('baseline source not requested (use --compare-baseline to enable)')
  }

  const resolved = {
    generatedAt: new Date().toISOString(),
    modelsDir,
    candidate,
    baseline,
    model: { id: m.id, ctxSize: m.ctxSize, nPredict: m.nPredict }
  }
  const outPath = path.join(SCRIPT_DIR, 'resolved-models.json')
  fs.writeFileSync(outPath, JSON.stringify(resolved, null, 2) + '\n', 'utf8')
  log(`wrote ${outPath}`)
}

main().catch((err) => {
  console.error(`[prepare-models] failed: ${err && err.message ? err.message : String(err)}`)
  process.exit(1)
})
