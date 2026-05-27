#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { QVACRegistryClient } = require('@qvac/registry-client')

const REGISTRY_DATE_Q8_0 = '2026-05-11'
const REGISTRY_DATE_Q4_0 = '2026-05-27'
const REGISTRY_DATE_STREAMING = '2026-05-20'
const REGISTRY_SOURCE = 's3'
const OUT_DIR = path.resolve(__dirname, '..', 'models')

const ALL_TYPES = ['ctc', 'tdt', 'eou', 'sortformer', 'sortformer-streaming-v2.1']
const ALL_QUANTS = ['f16', 'q8_0', 'q4_0']

const MODELS = {
  ctc: {
    q8_0: filenameAt(REGISTRY_DATE_Q8_0, 'parakeet-ctc-0.6b.q8_0.gguf'),
    q4_0: filenameAt(REGISTRY_DATE_Q4_0, 'parakeet-ctc-0.6b.q4_0.gguf')
  },
  tdt: {
    q8_0: filenameAt(REGISTRY_DATE_Q8_0, 'parakeet-tdt-0.6b-v3.q8_0.gguf'),
    q4_0: filenameAt(REGISTRY_DATE_Q4_0, 'parakeet-tdt-0.6b-v3.q4_0.gguf')
  },
  eou: {
    q8_0: filenameAt(REGISTRY_DATE_Q8_0, 'parakeet-eou-120m-v1.q8_0.gguf'),
    q4_0: filenameAt(REGISTRY_DATE_Q4_0, 'parakeet-eou-120m-v1.q4_0.gguf')
  },
  sortformer: {
    q8_0: filenameAt(REGISTRY_DATE_Q8_0, 'sortformer-4spk-v1.q8_0.gguf'),
    q4_0: filenameAt(REGISTRY_DATE_Q4_0, 'sortformer-4spk-v1.q4_0.gguf')
  },
  'sortformer-streaming-v2.1': {
    f16: filenameAt(REGISTRY_DATE_STREAMING, 'diar_streaming_sortformer_4spk-v2.1.f16.gguf'),
    q8_0: filenameAt(REGISTRY_DATE_STREAMING, 'diar_streaming_sortformer_4spk-v2.1.q8_0.gguf'),
    q4_0: filenameAt(REGISTRY_DATE_STREAMING, 'diar_streaming_sortformer_4spk-v2.1.q4_0.gguf')
  }
}

function filenameAt (date, filename) {
  return {
    filename,
    registryPath: `qvac_models_compiled/ggml/parakeet/${date}/${filename}`,
    registrySource: REGISTRY_SOURCE
  }
}

function parseArgs (argv) {
  const args = { type: 'all', quant: 'q8_0', output: OUT_DIR }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = argv[i + 1]
    if (flag === '--type' || flag === '-t') {
      args.type = next
      i++
    } else if (flag === '--quant' || flag === '-q') {
      args.quant = next
      i++
    } else if (flag === '--output' || flag === '-o') {
      args.output = path.resolve(next)
      i++
    } else if (flag === '--help' || flag === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${flag}`)
    }
  }
  return args
}

function printUsage () {
  console.log(`Usage: node scripts/download-parakeet-models.js [--type <T>] [--quant <Q>] [--output <DIR>]

Download Parakeet GGUFs from the QVAC model registry into ./models/.
Runs alongside (not instead of) the .nemo -> .gguf conversion pipeline
exposed via "npm run setup-models".

Flags:
  --type, -t   ${ALL_TYPES.join('|')}|all   (default: all)
  --quant, -q  ${ALL_QUANTS.join('|')}                  (default: q8_0)
  --output, -o <dir>                                    (default: ./models)
  --help, -h
`)
}

function selectVariants (type, quant) {
  const types = type === 'all' ? ALL_TYPES : [type]
  const selected = []
  for (const t of types) {
    const variants = MODELS[t]
    if (!variants) throw new Error(`Unknown type: ${t}`)
    const variant = variants[quant]
    if (!variant) {
      console.warn(`  ! ${t}: no ${quant} variant in registry; skipping`)
      continue
    }
    selected.push({ type: t, ...variant })
  }
  return selected
}

async function downloadOne (client, variant, outputDir) {
  const dest = path.join(outputDir, variant.filename)
  if (fs.existsSync(dest)) {
    console.log(`  ✓ ${variant.filename} (already present)`)
    return { ok: true, path: dest, cached: true }
  }
  console.log(`  > ${variant.filename}`)
  console.log(`      from: ${variant.registrySource}/${variant.registryPath}`)
  await client.downloadModel(variant.registryPath, variant.registrySource, {
    outputFile: dest,
    timeout: 600000
  })
  return { ok: true, path: dest, cached: false }
}

async function downloadAll (variants, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true })
  const client = new QVACRegistryClient()
  let failures = 0
  try {
    await client.ready()
    for (const variant of variants) {
      try {
        await downloadOne(client, variant, outputDir)
      } catch (err) {
        console.error(`  ✗ ${variant.filename}: ${err && err.message ? err.message : String(err)}`)
        failures++
      }
    }
  } finally {
    try { await client.close() } catch (_) {}
  }
  return failures
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { printUsage(); return }

  const variants = selectVariants(args.type, args.quant)
  if (variants.length === 0) {
    console.error('Nothing to download for the requested type/quant.')
    process.exit(2)
  }

  console.log(`Downloading Parakeet GGUFs (quant=${args.quant}) into ${args.output}`)
  const failures = await downloadAll(variants, args.output)
  if (failures > 0) {
    console.error(`${failures} download(s) failed.`)
    process.exit(1)
  }
  console.log('Done.')
}

main().catch(err => {
  console.error(err && err.message ? err.message : err)
  process.exit(1)
})
