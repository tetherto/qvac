#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { QVACRegistryClient } = require('@qvac/registry-client')

const REGISTRY_SOURCE = 's3'
const REGISTRY_DATE_S3GEN_Q4_0 = '2026-06-01' // chatterbox-s3gen* / -s3gen-mtl* q4_0 (under ggml/chatterbox/)
const REGISTRY_DATE_Q4_0 = '2026-05-18'
// Supertonic 3: fp16 + fp32 GGUFs published under the 2026-06-10 build
// (QVAC-20568); the block-quant q8_0 / q4_0 tiers under the 2026-06-15 build
// (QVAC-20686).
const REGISTRY_DATE_SUPERTONIC3 = '2026-06-10'
const REGISTRY_DATE_SUPERTONIC3_QUANT = '2026-06-15'
const OUT_DIR = path.resolve(__dirname, '..', 'models')

const GROUPS = {
  chatterbox: [
    {
      name: 'chatterbox-t3-turbo.gguf',
      registryPath: `qvac_models_compiled/ggml/chatterbox/${REGISTRY_DATE_Q4_0}/chatterbox-t3-turbo-q4_0.gguf`
    },
    {
      name: 'chatterbox-s3gen.gguf',
      registryPath: `qvac_models_compiled/ggml/chatterbox/${REGISTRY_DATE_S3GEN_Q4_0}/chatterbox-s3gen-q4_0.gguf`
    }
  ],
  'chatterbox-mtl': [
    {
      name: 'chatterbox-t3-mtl.gguf',
      registryPath: `qvac_models_compiled/ggml/chatterbox/${REGISTRY_DATE_Q4_0}/chatterbox-t3-mtl-q4_0.gguf`
    },
    {
      name: 'chatterbox-s3gen-mtl.gguf',
      registryPath: `qvac_models_compiled/ggml/chatterbox/${REGISTRY_DATE_S3GEN_Q4_0}/chatterbox-s3gen-mtl-q4_0.gguf`
    }
  ],
  supertonic: [
    {
      name: 'supertonic.gguf',
      registryPath: `qvac_models_compiled/ggml/supertonic/${REGISTRY_DATE_Q4_0}/supertonic-q4_0.gguf`
    }
  ],
  supertonic2: [
    {
      name: 'supertonic2.gguf',
      registryPath: `qvac_models_compiled/ggml/supertonic/${REGISTRY_DATE_Q4_0}/supertonic2-q4_0.gguf`
    }
  ],
  // Supertonic 3 keeps the quant-tagged on-disk names (supertonic3-<tier>.gguf)
  // because the integration test resolves a specific tier by path; tts-cpp
  // reads the quant from GGUF metadata, not the filename.
  supertonic3: [
    {
      name: 'supertonic3-f16.gguf',
      registryPath: `qvac_models_compiled/ggml/supertonic/${REGISTRY_DATE_SUPERTONIC3}/supertonic3-f16.gguf`
    },
    {
      name: 'supertonic3-f32.gguf',
      registryPath: `qvac_models_compiled/ggml/supertonic/${REGISTRY_DATE_SUPERTONIC3}/supertonic3-f32.gguf`
    },
    {
      name: 'supertonic3-q8_0.gguf',
      registryPath: `qvac_models_compiled/ggml/supertonic/${REGISTRY_DATE_SUPERTONIC3_QUANT}/supertonic3-q8_0.gguf`
    },
    {
      name: 'supertonic3-q4_0.gguf',
      registryPath: `qvac_models_compiled/ggml/supertonic/${REGISTRY_DATE_SUPERTONIC3_QUANT}/supertonic3-q4_0.gguf`
    }
  ]
}

const ALL_GROUP_KEYS = Object.keys(GROUPS)

function parseArgs (argv) {
  const args = { groups: ['all'], output: OUT_DIR }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = argv[i + 1]
    if (flag === '--group' || flag === '-g') {
      args.groups = next.split(',').map(s => s.trim()).filter(Boolean)
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
  console.log(`Usage: node scripts/download-tts-ggml-models.js [--group <G>] [--output <DIR>]

Download TTS GGML GGUFs from the QVAC model registry into ./models/.
On-disk filenames stay at the historical "<name>.gguf" shape so the
tts-ggml resolver finds them without source changes — the script
rebadges the q4_0 variants accordingly.

Flags:
  --group, -g  ${ALL_GROUP_KEYS.join('|')}|all   (default: all; comma-separated for multiple)
  --output, -o <dir>                                       (default: ./models)
  --help, -h
`)
}

function selectFiles (groupArgs) {
  const wantAll = groupArgs.includes('all')
  const keys = wantAll ? ALL_GROUP_KEYS : groupArgs
  const files = []
  for (const key of keys) {
    const group = GROUPS[key]
    if (!group) throw new Error(`Unknown group: ${key}`)
    for (const f of group) files.push(f)
  }
  return files
}

async function downloadOne (client, file, outputDir) {
  const dest = path.join(outputDir, file.name)
  if (fs.existsSync(dest)) {
    console.log(`  ✓ ${file.name} (already present)`)
    return { ok: true, cached: true }
  }
  console.log(`  > ${file.name}`)
  console.log(`      from: ${REGISTRY_SOURCE}/${file.registryPath}`)
  await client.downloadModel(file.registryPath, REGISTRY_SOURCE, {
    outputFile: dest,
    timeout: 600000
  })
  return { ok: true, cached: false }
}

async function downloadAll (files, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true })
  const client = new QVACRegistryClient()
  let failures = 0
  try {
    await client.ready()
    for (const file of files) {
      try {
        await downloadOne(client, file, outputDir)
      } catch (err) {
        console.error(`  ✗ ${file.name}: ${err && err.message ? err.message : String(err)}`)
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

  const files = selectFiles(args.groups)
  if (files.length === 0) {
    console.error('Nothing to download for the requested group(s).')
    process.exit(2)
  }

  console.log(`Downloading TTS GGML GGUFs into ${args.output}`)
  console.log(`Groups: ${args.groups.join(', ')}`)
  const failures = await downloadAll(files, args.output)
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
