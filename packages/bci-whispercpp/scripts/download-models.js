#!/usr/bin/env node
'use strict'

// Downloads BCI assets needed to run the examples / integration tests.
//
//   - Model files  -> fetched from the QVAC model registry (S3 source),
//                     the same place the SDK resolves them from. No GitHub
//                     CLI, no auth: the registry client uses a baked-in
//                     default core key over Hyperswarm.
//   - Test fixtures -> the neural-signal samples are not published to the
//                     registry, so they are pulled from the public release
//                     tarball over plain HTTPS (override with
//                     BCI_FIXTURES_URL).
//
// Usage:
//   node scripts/download-models.js              # models + fixtures
//   node scripts/download-models.js --models     # models only
//   node scripts/download-models.js --fixtures   # fixtures only
//   node scripts/download-models.js --force      # re-download even if present
//   node scripts/download-models.js --output DIR # models dir (default ./models)

const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const { execFileSync } = require('child_process')

const PACKAGE_DIR = path.resolve(__dirname, '..')
const MODELS_DIR = path.join(PACKAGE_DIR, 'models')
const FIXTURES_DIR = path.join(PACKAGE_DIR, 'test', 'fixtures')

// Registry coordinates mirror the `source` field in
// registry-server/data/models.prod.json:
//   s3:///qvac_models_compiled/bci-whispercpp/2026-05-07/<file>
const REGISTRY_SOURCE = 's3'
const REGISTRY_DATE = '2026-05-07'
const MODELS = [
  { name: 'ggml-bci-windowed.bin' },
  { name: 'bci-embedder.bin' }
].map((m) => ({
  ...m,
  registryPath: `qvac_models_compiled/bci-whispercpp/${REGISTRY_DATE}/${m.name}`,
  registrySource: REGISTRY_SOURCE
}))

// Fixtures aren't in the registry; keep pulling them from the public release.
const FIXTURES_URL = process.env.BCI_FIXTURES_URL ||
  'https://github.com/tetherto/qvac/releases/download/bci-test-assets-v0.1.0/bci-test-fixtures.tar.gz'

function parseArgs (argv) {
  const args = { models: false, fixtures: false, force: false, output: MODELS_DIR }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    switch (flag) {
      case '--models': args.models = true; break
      case '--fixtures': args.fixtures = true; break
      case '--force': args.force = true; break
      case '--output': case '-o': args.output = path.resolve(argv[++i]); break
      case '--help': case '-h': args.help = true; break
      default: throw new Error(`Unknown argument: ${flag}`)
    }
  }
  // Default: do both when neither is explicitly requested.
  if (!args.models && !args.fixtures) { args.models = true; args.fixtures = true }
  return args
}

function printUsage () {
  console.log(`Usage: node scripts/download-models.js [--models] [--fixtures] [--force] [--output DIR]

Download BCI model files (from the QVAC model registry) and neural-signal
test fixtures (from the public release tarball) so the examples and
integration tests can run.

Flags:
  --models           models only (default: models + fixtures)
  --fixtures         fixtures only
  --force            re-download even if the file already exists
  --output, -o DIR   destination dir for models (default: ./models)
  --help, -h
`)
}

// Minimal HTTPS GET with redirect support (GitHub release -> S3 redirect).
function httpDownload (url, dest, redirects = 10) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http:') ? http : https
    const req = mod.get(url, { headers: { 'User-Agent': 'bci-whispercpp-download' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirects <= 0) { reject(new Error('Too many redirects')); return }
        const next = new URL(res.headers.location, url).toString()
        resolve(httpDownload(next, dest, redirects - 1))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''} for ${url}`))
        return
      }
      const tmp = `${dest}.tmp`
      const file = fs.createWriteStream(tmp)
      res.pipe(file)
      file.on('finish', () => file.close(() => { fs.renameSync(tmp, dest); resolve() }))
      file.on('error', (err) => { try { fs.unlinkSync(tmp) } catch (_) {} ; reject(err) })
    })
    req.on('error', reject)
  })
}

async function downloadModels (outputDir, force) {
  fs.mkdirSync(outputDir, { recursive: true })

  let QVACRegistryClient
  try {
    ({ QVACRegistryClient } = require('@qvac/registry-client'))
  } catch (err) {
    throw new Error(
      'Registry client (@qvac/registry-client) is not installed. ' +
      'Run `npm install` in packages/bci-whispercpp first.')
  }

  console.log('Downloading BCI model files from the QVAC registry...')
  const client = new QVACRegistryClient()
  let failures = 0
  try {
    await client.ready()
    for (const model of MODELS) {
      const dest = path.join(outputDir, model.name)
      if (!force && fs.existsSync(dest)) {
        console.log(`  ✓ ${model.name} (already present)`)
        continue
      }
      console.log(`  > ${model.name}`)
      console.log(`      from: ${model.registrySource}/${model.registryPath}`)
      try {
        await client.downloadModel(model.registryPath, model.registrySource, {
          outputFile: dest,
          timeout: 600000
        })
        console.log(`  ✓ ${model.name}`)
      } catch (err) {
        console.error(`  ✗ ${model.name}: ${err && err.message ? err.message : String(err)}`)
        failures++
      }
    }
  } finally {
    try { await client.close() } catch (_) {}
  }
  if (failures > 0) throw new Error(`${failures} model download(s) failed.`)
}

function pruneAppleDouble (dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('._')) {
      try { fs.unlinkSync(path.join(dir, name)) } catch (_) {}
    }
  }
}

async function downloadFixtures (force) {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true })

  // If samples already exist and we're not forcing, skip.
  const marker = path.join(FIXTURES_DIR, 'neural_sample_0.bin')
  if (!force && fs.existsSync(marker)) {
    console.log('Test fixtures already present (use --force to re-download).')
    return
  }

  // Stage the archive inside the fixtures dir and extract with a *relative*
  // filename (cwd = fixtures dir). Passing a drive-lettered absolute path
  // (e.g. C:\...) to tar makes GNU tar treat it as a remote "host:path",
  // so keeping it relative is the portable choice across Linux/macOS/Windows.
  const archiveName = 'bci-test-fixtures.tar.gz'
  const archivePath = path.join(FIXTURES_DIR, archiveName)
  try {
    console.log('Downloading BCI test fixtures...')
    console.log(`      from: ${FIXTURES_URL}`)
    await httpDownload(FIXTURES_URL, archivePath)
    execFileSync('tar', ['xzf', archiveName], { cwd: FIXTURES_DIR })
    // The archive was packed on macOS and carries AppleDouble sidecars
    // (._foo); they aren't real fixtures, so prune them after extraction.
    // Done in JS rather than via `tar --exclude` because that flag's
    // behaviour differs between GNU tar and bsdtar.
    pruneAppleDouble(FIXTURES_DIR)
    console.log(`  ✓ fixtures extracted to ${FIXTURES_DIR}`)
  } finally {
    try { fs.rmSync(archivePath, { force: true }) } catch (_) {}
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { printUsage(); return }

  if (args.models) await downloadModels(args.output, args.force)
  if (args.fixtures) await downloadFixtures(args.force)

  console.log('')
  console.log('Done. Run an example with:')
  console.log('  bare examples/transcribe-neural.js --batch')
  console.log('Or the integration tests with:')
  console.log(`  WHISPER_MODEL_PATH=${path.join(args.output, 'ggml-bci-windowed.bin')} npm run test:integration`)
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err)
  process.exit(1)
})
