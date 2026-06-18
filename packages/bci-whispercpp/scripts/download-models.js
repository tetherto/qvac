#!/usr/bin/env node
'use strict'

const fs = require('fs')
const https = require('https')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const PACKAGE_DIR = path.resolve(__dirname, '..')
const MODELS_DIR = path.join(PACKAGE_DIR, 'models')
const FIXTURES_DIR = path.join(PACKAGE_DIR, 'test', 'fixtures')
const REGISTRY_SOURCE = 's3'
const DOWNLOAD_TIMEOUT_MS = Number.parseInt(process.env.QVAC_BCI_DOWNLOAD_TIMEOUT_MS || '600000', 10)

const MODELS = [
  {
    filename: 'ggml-bci-windowed.bin',
    registryPath: 'qvac_models_compiled/bci-whispercpp/2026-05-07/ggml-bci-windowed.bin'
  },
  {
    filename: 'bci-embedder.bin',
    registryPath: 'qvac_models_compiled/bci-whispercpp/2026-05-07/bci-embedder.bin'
  }
]

const FIXTURE_ASSET = {
  owner: 'tetherto',
  repo: 'qvac',
  tag: 'bci-test-assets-v0.1.0',
  name: 'bci-test-fixtures.tar.gz'
}

function loadRegistryClient () {
  try {
    return require('@qvac/registry-client').QVACRegistryClient
  } catch {
    throw new Error(
      'Missing @qvac/registry-client. Run `npm install` in packages/bci-whispercpp before downloading BCI models.'
    )
  }
}

function parseMode (argv) {
  const mode = argv[0] || 'all'
  if (argv.length > 1) throw new Error(`Unexpected extra argument: ${argv[1]}`)
  if (mode === 'all' || mode === '--models' || mode === '--fixtures') return mode
  if (mode === '--help' || mode === '-h') return mode
  throw new Error(`Unknown option: ${mode}`)
}

function printUsage () {
  console.log(`Usage: node scripts/download-models.js [all|--models|--fixtures]

Downloads BCI model files from the QVAC model registry.
Downloads test fixtures from the bci-test-assets-v0.1.0 release without requiring gh.

Environment:
  QVAC_REGISTRY_CORE_KEY          Optional registry metadata core override
  QVAC_BCI_DOWNLOAD_TIMEOUT_MS    Optional model download timeout in ms (default: 600000)
  GH_TOKEN or GITHUB_TOKEN        Optional token for private fixture asset downloads
`)
}

function formatBytes (bytes) {
  const mib = bytes / 1024 / 1024
  return `${mib.toFixed(1)} MiB`
}

function listFiles (dir, filter) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(filter)
    .sort()
    .map(name => {
      const filePath = path.join(dir, name)
      return { name, size: fs.statSync(filePath).size }
    })
}

async function downloadModels () {
  const QVACRegistryClient = loadRegistryClient()

  fs.mkdirSync(MODELS_DIR, { recursive: true })

  console.log('Downloading BCI model files from QVAC registry...')
  console.log('  Output dir:', MODELS_DIR)

  const client = new QVACRegistryClient()
  try {
    await client.ready()
    for (const model of MODELS) {
      const outputFile = path.join(MODELS_DIR, model.filename)
      console.log(`  Downloading ${model.filename}`)
      console.log(`    from: ${REGISTRY_SOURCE}/${model.registryPath}`)
      await client.downloadModel(model.registryPath, REGISTRY_SOURCE, {
        outputFile,
        timeout: DOWNLOAD_TIMEOUT_MS
      })
      console.log(`    saved: ${outputFile}`)
    }
  } finally {
    try { await client.close() } catch (_) {}
  }

  console.log('Model files:')
  for (const file of listFiles(MODELS_DIR, name => name.endsWith('.bin'))) {
    console.log(`  ${file.name} (${formatBytes(file.size)})`)
  }
}

function getAuthHeaders () {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}

function dropCrossHostAuthHeaders (headers, fromUrl, toUrl) {
  if (fromUrl.hostname === toUrl.hostname) return headers
  const nextHeaders = { ...headers }
  delete nextHeaders.Authorization
  return nextHeaders
}

function requestBuffer (url, headers = {}) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url)
    const options = {
      headers: {
        'User-Agent': '@qvac/bci-whispercpp download-models',
        ...headers
      }
    }

    https.get(requestUrl, options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const redirectUrl = new URL(res.headers.location, requestUrl)
        requestBuffer(redirectUrl.toString(), dropCrossHostAuthHeaders(headers, requestUrl, redirectUrl))
          .then(resolve, reject)
        return
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        reject(new Error(`Request failed (${res.statusCode}) for ${requestUrl}`))
        return
      }

      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function downloadFile (url, outputFile, headers = {}) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url)
    const options = {
      headers: {
        'User-Agent': '@qvac/bci-whispercpp download-models',
        ...headers
      }
    }

    https.get(requestUrl, options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const redirectUrl = new URL(res.headers.location, requestUrl)
        downloadFile(
          redirectUrl.toString(),
          outputFile,
          dropCrossHostAuthHeaders(headers, requestUrl, redirectUrl)
        ).then(resolve, reject)
        return
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        reject(new Error(`Download failed (${res.statusCode}) for ${requestUrl}`))
        return
      }

      const out = fs.createWriteStream(outputFile)
      res.pipe(out)
      out.on('finish', () => out.close(resolve))
      out.on('error', reject)
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function downloadFixtureArchive (archivePath) {
  const authHeaders = getAuthHeaders()
  const hasToken = Boolean(authHeaders.Authorization)

  if (hasToken) {
    const releaseUrl = `https://api.github.com/repos/${FIXTURE_ASSET.owner}/${FIXTURE_ASSET.repo}/releases/tags/${FIXTURE_ASSET.tag}`
    const releaseBody = await requestBuffer(releaseUrl, {
      Accept: 'application/vnd.github+json',
      ...authHeaders
    })
    const release = JSON.parse(releaseBody.toString('utf8'))
    const asset = release.assets.find(asset => asset.name === FIXTURE_ASSET.name)
    if (!asset) throw new Error(`Fixture asset not found in release: ${FIXTURE_ASSET.name}`)

    await downloadFile(asset.url, archivePath, {
      Accept: 'application/octet-stream',
      ...authHeaders
    })
    return
  }

  const publicUrl = `https://github.com/${FIXTURE_ASSET.owner}/${FIXTURE_ASSET.repo}/releases/download/${FIXTURE_ASSET.tag}/${FIXTURE_ASSET.name}`
  await downloadFile(publicUrl, archivePath)
}

async function downloadFixtures () {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true })
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bci-test-fixtures-'))
  const archivePath = path.join(tempDir, FIXTURE_ASSET.name)

  try {
    console.log('Downloading BCI test fixtures...')
    await downloadFixtureArchive(archivePath)

    const result = spawnSync('tar', ['xzf', archivePath, '-C', FIXTURES_DIR], {
      stdio: 'inherit'
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`tar exited with status ${result.status}`)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  console.log('Test fixtures:')
  for (const file of listFiles(FIXTURES_DIR, name => name.endsWith('.bin'))) {
    console.log(`  ${file.name} (${formatBytes(file.size)})`)
  }
}

async function main () {
  const mode = parseMode(process.argv.slice(2))
  if (mode === '--help' || mode === '-h') {
    printUsage()
    return
  }

  if (mode === '--models') {
    await downloadModels()
  } else if (mode === '--fixtures') {
    await downloadFixtures()
  } else {
    await downloadModels()
    console.log('')
    await downloadFixtures()
  }

  console.log('')
  console.log('Done. Run tests with: npm run test:integration')
}

main().catch(err => {
  console.error(err && err.message ? err.message : err)
  process.exit(1)
})
