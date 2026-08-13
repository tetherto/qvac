#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const {
  REGISTRY_SOURCE,
  DEFAULT_DIT_VARIANT,
  ditVariants,
  modelManifest,
  allRegistryPaths
} = require('../models.js')

const DOWNLOAD_TIMEOUT_MS = 1800000
const BYTE_UNIT = 1024
const PERCENT_SCALE = 100
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB']
const COMMAND_NAME = 'qvac-audiogen-download-models'

function parseArgs(argv) {
  const args = { output: undefined, variant: DEFAULT_DIT_VARIANT }
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
  console.log(`Usage: ${COMMAND_NAME} --output <dir> [--variant <v>]

Download the ACE-Step GGUFs from the QVAC model registry into <dir>.

  --output, -o   <dir>                              required
  --variant, -v  ${ditVariants().join('|')}|all   (default: ${DEFAULT_DIT_VARIANT})
  --help, -h
`)
}

function pathsFor(variant) {
  if (variant === 'all') return allRegistryPaths()
  const m = modelManifest(variant)
  return [m.textEnc, m.lm, m.dit, m.vae]
}

function humanBytes(n) {
  if (n === null || n === undefined) return '?'
  let i = 0
  let v = n
  while (v >= BYTE_UNIT && i < BYTE_UNITS.length - 1) {
    v /= BYTE_UNIT
    i++
  }
  return `${v.toFixed(1)} ${BYTE_UNITS[i]}`
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
    timeout: DOWNLOAD_TIMEOUT_MS,
    onProgress: ({ downloaded, total }) => {
      if (!total) return
      const pct = Math.floor((downloaded / total) * PERCENT_SCALE)
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

async function downloadPaths(client, registryPaths, outputDir) {
  for (const registryPath of registryPaths) {
    await downloadOne(client, registryPath, outputDir)
  }
}

function createRegistryClient() {
  try {
    const { QVACRegistryClient } = require('@qvac/registry-client')
    return new QVACRegistryClient()
  } catch (error) {
    throw new Error('Install @qvac/registry-client to download AudioGen models', {
      cause: error
    })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()
  if (!args.output) throw new Error('--output is required')

  const paths = pathsFor(args.variant)
  fs.mkdirSync(args.output, { recursive: true })

  console.log(`Downloading ACE-Step GGUFs (variant: ${args.variant}) into ${args.output}`)
  const client = createRegistryClient()
  await client.ready()
  try {
    await downloadPaths(client, paths, args.output)
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
