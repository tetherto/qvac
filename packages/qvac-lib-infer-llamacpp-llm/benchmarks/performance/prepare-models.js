#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')

function parseArgs (argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i++
    }
  }
  return args
}

function asArray (value) {
  return String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function quantizationPatterns (quantization) {
  const q = String(quantization || '').toUpperCase()
  const patterns = [q.toLowerCase()]
  if (q === 'F16') patterns.push('f16', 'fp16', 'bf16')
  else if (q === 'F32') patterns.push('f32', 'fp32')
  else if (q === 'Q8_0') patterns.push('q8_0', 'q8-0', 'q8.0', 'q80')
  else if (q === 'Q4_0') patterns.push('q4_0', 'q4-0', 'q4.0', 'q40')
  else if (q === 'Q4_K_M') patterns.push('q4_k_m', 'q4-k-m', 'q4km')
  return [...new Set(patterns)]
}

function filenameCandidates (repo, quantization) {
  const repoName = String(repo).split('/').slice(-1)[0]
  const stem = repoName.toUpperCase().endsWith('-GGUF') ? repoName.slice(0, -5) : repoName
  const quant = String(quantization).toUpperCase()
  const candidates = [
    `${stem}-${quant}.gguf`,
    `${stem}-${quant.toLowerCase()}.gguf`
  ]
  if (quant === 'F16') {
    candidates.push(`${stem}-f16.gguf`)
    candidates.push(`${stem}-bf16.gguf`)
  }
  return [...new Set(candidates)]
}

function toPortableRelativePath (baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath)
  if (!relative) return '.'
  return relative.split(path.sep).join('/')
}

function requestBuffer (url, headers, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirects <= 0) {
          reject(new Error(`Too many redirects for ${url}`))
          return
        }
        const nextUrl = new URL(res.headers.location, url).toString()
        resolve(requestBuffer(nextUrl, headers, redirects - 1))
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        const err = new Error(`HTTP ${status}`)
        err.code = status
        err.url = url
        reject(err)
        return
      }
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

function downloadFile (url, destination, headers, redirects = 5) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const tmpPath = `${destination}.partial`
    const out = fs.createWriteStream(tmpPath)
    let settled = false

    const cleanupTmp = () => {
      try {
        if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath)
      } catch {}
    }

    const fail = (error) => {
      if (settled) return
      settled = true
      try { out.destroy() } catch {}
      cleanupTmp()
      reject(error)
    }

    const succeed = () => {
      if (settled) return
      settled = true
      try {
        fs.renameSync(tmpPath, destination)
        resolve()
      } catch (error) {
        reject(error)
      }
    }

    const req = https.get(url, { headers }, (res) => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirects <= 0) {
          fail(new Error(`Too many redirects for ${url}`))
          return
        }
        const nextUrl = new URL(res.headers.location, url).toString()
        settled = true
        try { out.destroy() } catch {}
        cleanupTmp()
        resolve(downloadFile(nextUrl, destination, headers, redirects - 1))
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        const err = new Error(`HTTP ${status}`)
        err.code = status
        err.url = url
        fail(err)
        return
      }
      res.pipe(out)
      out.on('finish', () => out.close(succeed))
      res.on('error', fail)
    })

    req.on('error', fail)
    out.on('error', (error) => {
      req.destroy()
      fail(error)
    })
  })
}

async function listRepoGgufFiles (repo, revision, headers) {
  const encodedRepo = String(repo)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  const apiUrl = `https://huggingface.co/api/models/${encodedRepo}?revision=${encodeURIComponent(revision)}`
  const payloadRaw = await requestBuffer(apiUrl, headers)
  const payload = JSON.parse(payloadRaw.toString('utf8'))
  const siblings = Array.isArray(payload.siblings) ? payload.siblings : []
  return siblings
    .map((x) => x && x.rfilename)
    .filter((name) => typeof name === 'string' && name.endsWith('.gguf'))
}

async function resolveGgufFilenameForQuantization (repo, revision, quantization, headers) {
  const ggufFiles = await listRepoGgufFiles(repo, revision, headers)
  if (ggufFiles.length === 0) {
    throw new Error(`No GGUF files found in Hugging Face repo ${repo}@${revision}`)
  }

  const patterns = quantizationPatterns(quantization)
  const patternMatches = ggufFiles.filter((candidate) => {
    const lower = path.basename(candidate).toLowerCase()
    return patterns.some((pattern) => lower.includes(pattern))
  })

  if (patternMatches.length === 1) return patternMatches[0]
  if (patternMatches.length > 1) {
    throw new Error(
      `Ambiguous GGUF matches for quantization ${quantization} in ${repo}@${revision}: ${JSON.stringify(patternMatches)}. ` +
      'Narrow manifest quantizations or add disambiguation logic.'
    )
  }

  throw new Error(
    `No matching GGUF file found for quantization='${quantization}' in ${repo}@${revision}. ` +
    `Available files: ${JSON.stringify(ggufFiles)}`
  )
}

function loadManifest (manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`)
  }
  const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (!data || !Array.isArray(data.models)) {
    throw new Error("Invalid manifest: expected top-level 'models' array")
  }
  return data
}

function selectModels (models, selectedIds) {
  if (selectedIds.size === 0) return models
  const selected = models.filter((m) => selectedIds.has(m.id))
  const missing = [...selectedIds].filter((id) => !selected.some((m) => m.id === id)).sort()
  if (missing.length > 0) {
    throw new Error(`Unknown model IDs in --models: ${missing.join(', ')}`)
  }
  return selected
}

async function prepareAddonModels (selectedModels, modelsDir, headers, baseDir) {
  const resolved = {}
  fs.mkdirSync(modelsDir, { recursive: true })

  for (const model of selectedModels) {
    const modelId = model.id
    const gguf = model.gguf || {}
    const repo = gguf.repo
    const revision = gguf.revision || 'main'
    const quantizations = gguf.quantizations || []

    if (!repo) throw new Error(`Manifest model ${modelId} missing gguf.repo`)
    if (!Array.isArray(quantizations) || quantizations.length === 0) {
      throw new Error(`Manifest model ${modelId} missing gguf.quantizations array`)
    }

    const quantFiles = {}
    for (const quantization of quantizations) {
      if (!quantization || typeof quantization !== 'string') {
        throw new Error(`Manifest model ${modelId} has invalid quantization: ${JSON.stringify(quantization)}`)
      }

      let selectedFilename = null
      let destination = null
      let last404Url = null

      for (const candidateFilename of filenameCandidates(repo, quantization)) {
        const candidateDestination = path.join(modelsDir, candidateFilename)
        if (fs.existsSync(candidateDestination)) {
          selectedFilename = candidateFilename
          destination = candidateDestination
          console.log(`[addon] ${modelId}:${quantization} already present -> ${candidateDestination}`)
          break
        }

        const url = `https://huggingface.co/${repo}/resolve/${revision}/${candidateFilename}`
        console.log(`[addon] downloading ${modelId}:${quantization} from ${url}`)
        try {
          await downloadFile(url, candidateDestination, headers)
          selectedFilename = candidateFilename
          destination = candidateDestination
          break
        } catch (error) {
          if (error && error.code === 404) {
            last404Url = url
            continue
          }
          throw new Error(`Failed download for ${modelId}:${quantization} (${url}): ${error && error.message ? error.message : String(error)}`)
        }
      }

      if (!selectedFilename || !destination) {
        selectedFilename = await resolveGgufFilenameForQuantization(repo, revision, quantization, headers)
        destination = path.join(modelsDir, path.basename(selectedFilename))
        if (fs.existsSync(destination)) {
          console.log(`[addon] resolved existing file ${selectedFilename} for ${modelId}:${quantization}`)
        } else {
          const url = `https://huggingface.co/${repo}/resolve/${revision}/${selectedFilename}`
          if (last404Url) {
            console.log(`[addon] retrying after 404 (${last404Url}) with resolved filename ${selectedFilename}`)
          } else {
            console.log(`[addon] downloading ${modelId}:${quantization} from resolved filename ${selectedFilename}`)
          }
          await downloadFile(url, destination, headers)
        }
      }

      quantFiles[quantization] = toPortableRelativePath(baseDir, destination)
    }

    resolved[modelId] = {
      gguf: {
        repo,
        revision,
        files: quantFiles
      }
    }
  }

  return resolved
}

async function main () {
  const scriptDir = __dirname
  const args = parseArgs(process.argv)
  const manifestPath = path.resolve(String(args.manifest || path.join(scriptDir, 'models.manifest.json')))
  const target = String(args.target || 'addon')
  if (!['addon', 'all'].includes(target)) {
    throw new Error(`Invalid --target: ${target}. Expected addon or all.`)
  }
  const modelsDir = path.resolve(String(args['models-dir'] || path.join(scriptDir, 'models')))
  const outputPath = path.resolve(String(args.output || path.join(scriptDir, 'resolved-models.json')))
  const selectedIds = new Set(asArray(args.models))
  const hfToken = process.env.HF_TOKEN || null

  const headers = { 'User-Agent': 'qvac-benchmark-model-prep/1.0' }
  if (hfToken) headers.Authorization = `Bearer ${hfToken}`

  const manifest = loadManifest(manifestPath)
  const selectedModels = selectModels(manifest.models, selectedIds)

  const resolved = {
    manifestPath: toPortableRelativePath(scriptDir, manifestPath),
    modelsDir: toPortableRelativePath(scriptDir, modelsDir),
    target,
    models: {}
  }

  if (target === 'addon' || target === 'all') {
    const addonModels = await prepareAddonModels(selectedModels, modelsDir, headers, scriptDir)
    for (const [modelId, payload] of Object.entries(addonModels)) {
      resolved.models[modelId] = Object.assign(resolved.models[modelId] || {}, payload)
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(resolved, null, 2)}\n`, 'utf8')
  console.log(`Resolved models written to: ${outputPath}`)
}

main().catch((error) => {
  console.error(`prepare-models.js failed: ${error && error.message ? error.message : String(error)}`)
  process.exit(1)
})
