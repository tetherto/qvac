#!/usr/bin/env node
'use strict'

// Resolves the LLM + mmproj files needed by the benchmark and writes
// their paths to resolved-models.json. Resolution order:
//   1. --local-model / --local-mmproj  (existing files on disk)
//   2. registry-server (when QVAC_REGISTRY_URL is set)
//   3. Hugging Face URL fallback (config.model.huggingFace)
//
// The registry path is what CI uses; the HF URL is the local-dev fallback
// (concern 7.5). Either one keeps the model pinned to a specific revision.

const fs = require('fs')
const path = require('path')
const https = require('https')

const config = require('./vlm-bench.config')
const { parseArgs } = require('./utils')

const SCRIPT_DIR = __dirname
const DEFAULT_MODELS_DIR = path.join(SCRIPT_DIR, 'models')

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

async function tryRegistry (registryId, destination, headers) {
  const baseUrl = process.env.QVAC_REGISTRY_URL
  if (!baseUrl) return null
  // The exact registry-server URL shape is project-internal. We attempt
  // the documented '/models/<id>/file' pattern; if the registry surfaces
  // a different shape, set QVAC_REGISTRY_URL to a template like
  // 'https://registry.example/api/models/{id}/download' and we'll
  // substitute {id}.
  let url
  if (baseUrl.includes('{id}')) {
    url = baseUrl.replace('{id}', encodeURIComponent(registryId))
  } else {
    url = `${baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(registryId)}/file`
  }
  log(`registry lookup: ${url}`)
  try {
    await downloadFile(url, destination, headers)
    return destination
  } catch (e) {
    log(`registry lookup failed (${e.message || e}); falling back to HF`)
    return null
  }
}

async function resolveOne ({ label, localOverride, registryId, hfUrl, destination, headers }) {
  if (localOverride) {
    if (!fs.existsSync(localOverride)) {
      throw new Error(`--${label}=${localOverride}: file not found`)
    }
    log(`${label}: using local file ${localOverride}`)
    return path.resolve(localOverride)
  }
  if (fs.existsSync(destination)) {
    log(`${label}: already present -> ${destination}`)
    return destination
  }
  const viaRegistry = await tryRegistry(registryId, destination, headers)
  if (viaRegistry) {
    log(`${label}: downloaded via registry -> ${viaRegistry}`)
    return viaRegistry
  }
  log(`${label}: downloading from HF -> ${hfUrl}`)
  await downloadFile(hfUrl, destination, headers)
  log(`${label}: downloaded -> ${destination}`)
  return destination
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const modelsDir = args['models-dir'] ? path.resolve(args['models-dir']) : DEFAULT_MODELS_DIR
  ensureDir(modelsDir)

  const headers = { 'User-Agent': 'qvac-vlm-benchmark-prep/1.0' }
  if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`

  const m = config.model
  const llmDest = path.join(modelsDir, m.llmFile)
  const mmprojDest = path.join(modelsDir, m.mmprojFile)
  const llmHfUrl = `https://huggingface.co/${m.huggingFace.repo}/resolve/${m.huggingFace.revision}/${m.huggingFace.llmFilename}`
  const mmprojHfUrl = `https://huggingface.co/${m.huggingFace.repo}/resolve/${m.huggingFace.revision}/${m.huggingFace.mmprojFilename}`

  const llmPath = await resolveOne({
    label: 'local-model',
    localOverride: args['local-model'],
    registryId: m.registry.llmId,
    hfUrl: llmHfUrl,
    destination: llmDest,
    headers
  })
  const mmprojPath = await resolveOne({
    label: 'local-mmproj',
    localOverride: args['local-mmproj'],
    registryId: m.registry.mmprojId,
    hfUrl: mmprojHfUrl,
    destination: mmprojDest,
    headers
  })

  const resolved = {
    generatedAt: new Date().toISOString(),
    modelsDir,
    llmPath,
    mmprojPath,
    model: m
  }
  const outPath = path.join(SCRIPT_DIR, 'resolved-models.json')
  fs.writeFileSync(outPath, JSON.stringify(resolved, null, 2) + '\n', 'utf8')
  log(`wrote ${outPath}`)
}

main().catch((err) => {
  console.error(`[prepare-models] failed: ${err && err.message ? err.message : String(err)}`)
  process.exit(1)
})
