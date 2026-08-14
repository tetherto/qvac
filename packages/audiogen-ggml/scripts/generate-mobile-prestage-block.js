#!/usr/bin/env node
'use strict'

const { execFileSync } = require('child_process')
const { DEFAULT_DIT_VARIANT, modelFilenames, modelManifest } = require('../models.js')

const ANDROID_MODEL_DIR = '/data/local/tmp/prestaged-audiogen-models'
const HOST_MODEL_DIR = '/tmp/audiogen-prestage'
const DEFAULT_EXPIRES_IN = '7200'

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

function presignEntries(
  bucket,
  entries = prestageEntries(),
  expiresIn = DEFAULT_EXPIRES_IN,
  run = execFileSync
) {
  if (!bucket) throw new Error('MODEL_S3_BUCKET env var is required')
  return entries.map((entry) => ({
    name: entry.name,
    url: run(
      'aws',
      ['s3', 'presign', `s3://${bucket}/${entry.registryPath}`, '--expires-in', expiresIn],
      { encoding: 'utf8' }
    ).trim()
  }))
}

function buildAndroidScript(entries) {
  const stageCalls = entries.map((entry) => `stage '${entry.name}' '${entry.url}'`).join('\n')
  return `set -e
PRESTAGE_DIR='${ANDROID_MODEL_DIR}'
HOST_DIR='${HOST_MODEL_DIR}'
adb shell rm -rf "$PRESTAGE_DIR"
adb shell mkdir -p "$PRESTAGE_DIR"
rm -rf "$HOST_DIR"
mkdir -p "$HOST_DIR"
stage() {
  NAME="$1"
  URL="$2"
  echo "[audiogen/prestage] staging $NAME"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 \
    --connect-timeout 30 --max-time 3600 -o "$HOST_DIR/$NAME" "$URL"
  SIZE=$(wc -c < "$HOST_DIR/$NAME")
  [ "$SIZE" -ge 16777216 ] || {
    echo "[audiogen/prestage] FATAL: $NAME is only $SIZE bytes"
    exit 1
  }
  MAGIC=$(dd if="$HOST_DIR/$NAME" bs=4 count=1 2>/dev/null)
  [ "$MAGIC" = "GGUF" ] || {
    echo "[audiogen/prestage] FATAL: $NAME has invalid GGUF magic"
    exit 1
  }
  adb push "$HOST_DIR/$NAME" "$PRESTAGE_DIR/$NAME"
  adb shell test -s "$PRESTAGE_DIR/$NAME" || {
    echo "[audiogen/prestage] FATAL: $NAME missing after adb push"
    exit 1
  }
  rm -f "$HOST_DIR/$NAME"
}
${stageCalls}
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
  const signedEntries = presignEntries(
    process.env.MODEL_S3_BUCKET,
    prestageEntries(variant),
    process.env.MODEL_PRESIGN_EXPIRES_IN || DEFAULT_EXPIRES_IN
  )
  process.stdout.write(asYamlBlock(buildAndroidScript(signedEntries)))
}

if (require.main === module) main()

module.exports = {
  ANDROID_MODEL_DIR,
  HOST_MODEL_DIR,
  prestageEntries,
  presignEntries,
  buildAndroidScript,
  asYamlBlock
}
