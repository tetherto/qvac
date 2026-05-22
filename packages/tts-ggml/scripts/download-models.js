#!/usr/bin/env node
'use strict'

// Pre-stage Chatterbox + Supertonic GGUFs from the QVAC model
// registry into ./models/ (or --output).  Drop-in replacement for the
// HuggingFace -> Python -> convert-models.sh pipeline for CI: avoids
// installing Python + Torch + the converter requirements on every
// desktop runner.
//
// Runs under plain Node (the registry-client carries its own bare/node
// compat shim) so no `bare` install is needed in this step.
//
// Idempotent: a file already present at a size inside its declared
// band is left alone unless --force is passed.
//
// Usage:
//   node scripts/download-models.js [flags]
//
// Flags:
//   --type, -t <all|chatterbox|chatterbox-mtl|supertonic|supertonic-mtl>
//                         Which group(s) to fetch (default: all).
//   --output, -o <path>   Destination dir (default: ./models).
//   --force, -f           Re-download even if the cached file already
//                         passes the size band check.
//   --help, -h            Show this help.
//
// Examples:
//   node scripts/download-models.js
//   node scripts/download-models.js --type supertonic
//   node scripts/download-models.js -t chatterbox -o /tmp/m -f

const fs = require('fs')
const path = require('path')

const { getGroup } = require('./registry-models')

const DEFAULT_OUTPUT_DIR = './models'
const DEFAULT_GROUP = 'all'
const BYTES_IN_GIB = 1024 * 1024 * 1024
const BYTES_IN_MIB = 1024 * 1024
const BYTES_IN_KIB = 1024

function printUsage () {
  const lines = [
    'Pre-stage Chatterbox + Supertonic GGUFs from the QVAC model registry.',
    '',
    'Usage:',
    '  node scripts/download-models.js [flags]',
    '',
    'Flags:',
    '  --type, -t <all|chatterbox|chatterbox-mtl|supertonic|supertonic-mtl>',
    '                        Which group(s) to fetch (default: all).',
    '  --output, -o <path>   Destination dir (default: ./models).',
    '  --force, -f           Re-download even if the cached file already',
    '                        passes the size band check.',
    '  --help, -h            Show this help.'
  ]
  for (const l of lines) console.error(l)
}

function parseArgs (argv) {
  const opts = {
    type: DEFAULT_GROUP,
    output: DEFAULT_OUTPUT_DIR,
    force: false,
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--type':
      case '-t':
        opts.type = argv[++i]
        break
      case '--output':
      case '-o':
        opts.output = argv[++i]
        break
      case '--force':
      case '-f':
        opts.force = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new Error(`Unknown flag: ${a}`)
    }
  }
  return opts
}

function bytesHuman (b) {
  if (!b || b <= 0) return '0 B'
  if (b >= BYTES_IN_GIB) return (b / BYTES_IN_GIB).toFixed(2) + ' GiB'
  if (b >= BYTES_IN_MIB) return (b / BYTES_IN_MIB).toFixed(2) + ' MiB'
  if (b >= BYTES_IN_KIB) return (b / BYTES_IN_KIB).toFixed(2) + ' KiB'
  return b + ' B'
}

function ensureOutputDir (dir) {
  if (fs.existsSync(dir)) return
  fs.mkdirSync(dir, { recursive: true })
}

function statSizeOrZero (filepath) {
  try {
    return fs.statSync(filepath).size
  } catch (_e) {
    return 0
  }
}

function isCachedInBand (filepath, gguf) {
  const size = statSizeOrZero(filepath)
  if (size <= 0) return false
  if (size < gguf.minSize) return false
  if (gguf.maxSize && size > gguf.maxSize) return false
  return true
}

function reportCachedHit (filepath, size) {
  console.log(`  ✓ ${path.basename(filepath)} cached (${bytesHuman(size)})`)
}

function reportCacheReplaced (filepath, size, reason) {
  console.log(`  ↻ ${path.basename(filepath)} ${reason} (${bytesHuman(size)} on disk); re-fetching`)
}

function reasonForRefetch (size, gguf) {
  if (size < gguf.minSize) return `cached too small (< ${bytesHuman(gguf.minSize)})`
  if (gguf.maxSize && size > gguf.maxSize) return `cached too large (> ${bytesHuman(gguf.maxSize)}); stale quant tier?`
  return 'cache invalid'
}

function removeIfExists (filepath) {
  try {
    fs.unlinkSync(filepath)
  } catch (_e) {}
}

function loadRegistryClient () {
  try {
    return require('@qvac/registry-client')
  } catch (err) {
    throw new Error(
      'Cannot load @qvac/registry-client. Run `npm install` in this ' +
      `package first. Original error: ${err.message}`
    )
  }
}

async function openRegistryClient () {
  const { QVACRegistryClient } = loadRegistryClient()
  const client = new QVACRegistryClient()
  await client.ready()
  return client
}

async function closeRegistryClient (client) {
  if (!client) return
  try {
    await client.close()
  } catch (_e) {}
}

async function downloadOne (client, gguf, outputDir, force) {
  const dest = path.join(outputDir, gguf.name)

  const cachedSize = statSizeOrZero(dest)
  if (!force && cachedSize > 0) {
    if (isCachedInBand(dest, gguf)) {
      reportCachedHit(dest, cachedSize)
      return { name: gguf.name, path: dest, cached: true, success: true }
    }
    reportCacheReplaced(dest, cachedSize, reasonForRefetch(cachedSize, gguf))
    removeIfExists(dest)
  } else if (force && cachedSize > 0) {
    reportCacheReplaced(dest, cachedSize, 'forced refresh')
    removeIfExists(dest)
  }

  console.log(`  ↓ ${gguf.name}`)
  console.log(`      registry path:   ${gguf.registryPath}`)
  console.log(`      registry source: ${gguf.registrySource}`)

  const result = await client.downloadModel(gguf.registryPath, gguf.registrySource, {
    outputFile: dest
  })

  if (!result || !result.artifact || !result.artifact.path) {
    throw new Error(`Registry returned no artifact path for ${gguf.name}`)
  }

  const downloadedSize = statSizeOrZero(dest)
  if (downloadedSize < gguf.minSize) {
    removeIfExists(dest)
    throw new Error(
      `Downloaded ${gguf.name} too small: ${bytesHuman(downloadedSize)} ` +
      `(expected >= ${bytesHuman(gguf.minSize)})`
    )
  }
  if (gguf.maxSize && downloadedSize > gguf.maxSize) {
    removeIfExists(dest)
    throw new Error(
      `Downloaded ${gguf.name} too large: ${bytesHuman(downloadedSize)} ` +
      `(expected <= ${bytesHuman(gguf.maxSize)})`
    )
  }

  console.log(`  ✓ ${gguf.name} downloaded (${bytesHuman(downloadedSize)})`)
  return { name: gguf.name, path: dest, cached: false, success: true }
}

async function downloadGroup (client, ggufs, outputDir, force) {
  const results = []
  let failures = 0
  for (const gguf of ggufs) {
    try {
      const r = await downloadOne(client, gguf, outputDir, force)
      results.push(r)
    } catch (err) {
      failures += 1
      results.push({ name: gguf.name, path: path.join(outputDir, gguf.name), success: false, error: err })
      console.error(`  ✗ ${gguf.name}: ${err.message || err}`)
    }
  }
  return { results, failures }
}

function summarise (groupName, outputDir, ggufs, results, failures, elapsedMs) {
  console.log('')
  console.log(`Group:    ${groupName}`)
  console.log(`Output:   ${outputDir}`)
  console.log(`Total:    ${ggufs.length}`)
  console.log(`Cached:   ${results.filter(r => r.success && r.cached).length}`)
  console.log(`Fetched:  ${results.filter(r => r.success && !r.cached).length}`)
  console.log(`Failed:   ${failures}`)
  console.log(`Elapsed:  ${(elapsedMs / 1000).toFixed(1)}s`)
}

async function runDownload (opts) {
  const ggufs = getGroup(opts.type)
  ensureOutputDir(opts.output)

  console.log(`Staging ${ggufs.length} GGUF(s) into ${opts.output} (group: ${opts.type})`)
  console.log('')

  const start = Date.now()
  const client = await openRegistryClient()
  try {
    const { results, failures } = await downloadGroup(client, ggufs, opts.output, opts.force)
    summarise(opts.type, opts.output, ggufs, results, failures, Date.now() - start)
    return failures === 0
  } finally {
    await closeRegistryClient(client)
  }
}

async function main () {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    printUsage()
    process.exit(2)
  }

  if (opts.help) {
    printUsage()
    process.exit(0)
  }

  let ok = false
  try {
    ok = await runDownload(opts)
  } catch (err) {
    console.error('')
    console.error(`Fatal: ${err.message || err}`)
    process.exit(1)
  }

  process.exit(ok ? 0 : 1)
}

main()
