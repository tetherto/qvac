#!/usr/bin/env node
'use strict'

const path = require('path')
const {
  DEFAULT_DIT_VARIANT,
  REGISTRY_SOURCE,
  modelFilenames,
  modelManifest
} = require('../models.js')

const ANDROID_MODEL_DIR = '/data/local/tmp/prestaged-audiogen-models'
const HOST_MODEL_DIR = '/tmp/audiogen-prestage'
const REGISTRY_CLIENT_SPEC = '@qvac/registry-client@^0.6.1'

function prestageEntries(variant = DEFAULT_DIT_VARIANT) {
  const files = modelFilenames(variant)
  const manifest = modelManifest(variant)
  return [
    { name: files.textEnc, registryPath: manifest.textEnc },
    { name: files.lm, registryPath: manifest.lm },
    { name: files.dit, registryPath: manifest.dit },
    { name: files.vae, registryPath: manifest.vae }
  ]
}

function buildAndroidScript(entries = prestageEntries()) {
  const manifest = Buffer.from(
    JSON.stringify({
      source: REGISTRY_SOURCE,
      entries
    })
  ).toString('base64')

  return `set -e
export AUDIOGEN_PRESTAGE_MANIFEST='${manifest}'
export AUDIOGEN_PRESTAGE_HOST_DIR='${HOST_MODEL_DIR}'
rm -rf "$AUDIOGEN_PRESTAGE_HOST_DIR"
mkdir -p "$AUDIOGEN_PRESTAGE_HOST_DIR"
echo "[audiogen/prestage] installing registry client on Device Farm host"
npm install --no-save --legacy-peer-deps '${REGISTRY_CLIENT_SPEC}'
node <<'AUDIOGEN_PRESTAGE_NODE'
const fs = require('fs')
const path = require('path')
const { QVACRegistryClient } = require('@qvac/registry-client')

const MIN_GGUF_BYTES = 16 * 1024 * 1024
const decoded = Buffer.from(process.env.AUDIOGEN_PRESTAGE_MANIFEST, 'base64').toString()
const manifest = JSON.parse(decoded)
const outputDir = process.env.AUDIOGEN_PRESTAGE_HOST_DIR

async function main () {
  const client = new QVACRegistryClient()
  await client.ready()
  try {
    for (const entry of manifest.entries) {
      const outputFile = path.join(outputDir, entry.name)
      const started = Date.now()
      console.log('[audiogen/prestage] downloading ' + entry.name)
      await client.downloadModel(entry.registryPath, manifest.source, {
        outputFile,
        timeout: 3600000
      })
      const size = fs.statSync(outputFile).size
      const fd = fs.openSync(outputFile, 'r')
      const magic = Buffer.alloc(4)
      try {
        fs.readSync(fd, magic, 0, magic.length, 0)
      } finally {
        fs.closeSync(fd)
      }
      if (size < MIN_GGUF_BYTES || magic.toString('latin1') !== 'GGUF') {
        throw new Error('invalid GGUF downloaded for ' + entry.name)
      }
      console.log('[audiogen/prestage] ready ' + entry.name + ' (' + size +
        ' bytes, ' + (Date.now() - started) + ' ms)')
    }
  } finally {
    try {
      await client.close()
    } catch (_) {}
  }
}

main().catch((error) => {
  console.error('[audiogen/prestage] ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
AUDIOGEN_PRESTAGE_NODE
PRESTAGE_DIR='${ANDROID_MODEL_DIR}'
adb shell rm -rf "$PRESTAGE_DIR"
adb shell mkdir -p "$PRESTAGE_DIR"
for FILE in "$AUDIOGEN_PRESTAGE_HOST_DIR"/*.gguf; do
  NAME=$(basename "$FILE")
  echo "[audiogen/prestage] pushing $NAME"
  adb push "$FILE" "$PRESTAGE_DIR/$NAME"
  adb shell test -s "$PRESTAGE_DIR/$NAME" || {
    echo "[audiogen/prestage] FATAL: $NAME missing after adb push"
    exit 1
  }
  rm -f "$FILE"
done
echo "[audiogen/prestage] device models:"
adb shell ls -lh "$PRESTAGE_DIR"
echo "[audiogen/prestage] done"`
}

function asYamlBlock(script) {
  return (
    '|\n' +
    script
      .split('\n')
      .map((line) => '  ' + line)
      .join('\n') +
    '\n'
  )
}

function main() {
  const platform = (process.argv[2] || 'android').toLowerCase()
  const variant = process.argv[3] || DEFAULT_DIT_VARIANT
  if (platform !== 'android') {
    throw new Error(`unsupported platform "${platform}" (expected android)`)
  }
  process.stdout.write(asYamlBlock(buildAndroidScript(prestageEntries(variant))))
}

if (require.main === module) main()

module.exports = {
  ANDROID_MODEL_DIR,
  HOST_MODEL_DIR,
  prestageEntries,
  buildAndroidScript,
  asYamlBlock
}
