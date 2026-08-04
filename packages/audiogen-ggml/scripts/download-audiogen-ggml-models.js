#!/usr/bin/env node
'use strict'

// App-side model downloader for @qvac/audiogen-ggml.
//
// The addon itself never downloads — it takes local file paths. This script
// plays the role the app/SDK plays: it resolves the ACE-Step GGUFs from the
// QVAC model registry (over hyperdrive, via @qvac/registry-client) into a local
// folder, so you can then point the addon at that folder (`modelDir`).
//
// Registry paths and the DiT-variant enum come from the addon's own manifest
// (models.js), so this stays in sync with what the addon expects.
//
//   node scripts/download-audiogen-ggml-models.js --output <dir> [--variant turbo-q4|turbo-q8|sft|all]
//
// Only the four stages of the chosen DiT variant are fetched (the three fixed
// stages + that DiT); use --variant all to fetch every DiT variant too.

const fs = require('fs')
const path = require('path')
const { QVACRegistryClient } = require('@qvac/registry-client')
const {
  REGISTRY_SOURCE,
  DEFAULT_DIT_VARIANT,
  ditVariants,
  modelManifest,
  allRegistryPaths
} = require('../models.js')

// Default download target: the package's own `models/` dir. Mirrors
// download-tts-ggml-models.js so `npm run download-models:registry` (no args)
// works both locally and in CI, which then points the integration tests at
// ./models. An explicit --output overrides it.
const OUT_DIR = path.resolve(__dirname, '..', 'models')

function parseArgs(argv) {
  const args = { output: OUT_DIR, variant: DEFAULT_DIT_VARIANT }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = argv[i + 1]
    if (flag === '--output' || flag === '-o') {
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`${flag} requires a directory path`)
      }
      args.output = path.resolve(next)
      i++
    } else if (flag === '--variant' || flag === '-v') {
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`${flag} requires a value (${ditVariants().join('|')}|all)`)
      }
      args.variant = next
      i++
    } else if (flag === '--help' || flag === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${flag}`)
    }
  }
  return args
}

function usage() {
  console.log(`Usage: node scripts/download-audiogen-ggml-models.js --output <dir> [--variant <v>]

Download the ACE-Step GGUFs from the QVAC model registry into <dir>.

  --output, -o   <dir>                              (default: ./models)
  --variant, -v  ${ditVariants().join('|')}|all   (default: ${DEFAULT_DIT_VARIANT})
  --help, -h
`)
}

// Registry paths to fetch for the requested variant (3 fixed + its DiT), or
// everything for "all".
function pathsFor(variant) {
  if (variant === 'all') return allRegistryPaths()
  const m = modelManifest(variant) // throws on an unknown variant
  return [m.textEnc, m.lm, m.dit, m.vae]
}

function humanBytes(n) {
  if (n === null || n === undefined) return '?'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${u[i]}`
}

async function downloadOne(client, registryPath, outputDir) {
  const name = path.basename(registryPath)
  const dest = path.join(outputDir, name)
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  [ok] ${name} (already present)`)
    return
  }
  process.stdout.write(`  -> ${name} ... `)
  let lastPct = -1
  await client.downloadModel(registryPath, REGISTRY_SOURCE, {
    outputFile: dest,
    timeout: 1800000,
    onProgress: ({ downloaded, total }) => {
      if (!total) return
      const pct = Math.floor((downloaded / total) * 100)
      if (pct !== lastPct) {
        lastPct = pct
        process.stdout.write(
          `\r  -> ${name} ... ${pct}% (${humanBytes(downloaded)}/${humanBytes(total)})   `
        )
      }
    }
  })
  process.stdout.write(`\r  [ok] ${name} (downloaded)                              \n`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()

  const paths = pathsFor(args.variant)
  fs.mkdirSync(args.output, { recursive: true })

  console.log(`Downloading ACE-Step GGUFs (variant: ${args.variant}) into ${args.output}`)
  const client = new QVACRegistryClient()
  await client.ready()
  try {
    for (const p of paths) await downloadOne(client, p, args.output)
  } finally {
    try {
      await client.close()
    } catch (_) {}
  }
  console.log('Done.')
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err)
  process.exit(1)
})
