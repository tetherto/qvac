'use strict'

const fs = require('fs')
const path = require('path')

const MANIFEST_PATH = path.resolve(__dirname, '../test/mobile/testAssets/model-manifest.json')
const PRESTAGE_DIR = '/data/local/tmp/qvac-tts-ggml/models'
const ALLOWED_VARIANTS = ['q4', 'q8']

// LavaSR axes map an on row (enhancer|denoiser === 'lavasr') to the manifest
// `lavasr` entry whose targetName carries that kind, so only the requested GGUF
// is pushed.
const LAVASR_AXES = [
  { flag: 'enhancer', kind: 'enhancer' },
  { flag: 'denoiser', kind: 'denoiser' }
]

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      'Missing test/mobile/testAssets/model-manifest.json. Run scripts/generate-mobile-model-manifest.js first.'
    )
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

function resolveVariant(rawVariant) {
  const variant = (rawVariant || 'q4').toLowerCase()
  if (!ALLOWED_VARIANTS.includes(variant)) {
    throw new Error(
      `Unsupported variant "${variant}". Expected one of: ${ALLOWED_VARIANTS.join(', ')}`
    )
  }
  return variant
}

function engineEntries(manifest, variant) {
  const entries = Array.isArray(manifest[variant]) ? manifest[variant] : []
  if (entries.length === 0) {
    throw new Error(`No manifest entries found for variant "${variant}"`)
  }
  return entries
}

// Only the LavaSR GGUFs whose axis the row turned on. An engine-only row wants
// nothing here, so its prestage list stays byte-for-byte what it was pre-LavaSR.
function requestedLavasrKinds(axes) {
  return LAVASR_AXES.filter((axis) => axes[axis.flag] === 'lavasr').map((axis) => axis.kind)
}

function lavasrEntries(manifest, axes) {
  const available = Array.isArray(manifest.lavasr) ? manifest.lavasr : []
  const kinds = requestedLavasrKinds(axes)
  return available.filter((entry) => kinds.some((kind) => entry.targetName.includes(kind)))
}

function qualityEntries(manifest, enabled) {
  return enabled === true && Array.isArray(manifest.quality) ? manifest.quality : []
}

function selectEntries(manifest, options) {
  return engineEntries(manifest, options.variant)
    .concat(lavasrEntries(manifest, options))
    .concat(qualityEntries(manifest, options.quality))
}

function buildTsv(entries) {
  return entries.map((entry) => `${entry.targetName}\t${entry.url}`).join('\n') + '\n'
}

// Host commands run before the Device Farm test: download each model on the
// host, then adb-push it to PRESTAGE_DIR. dirname handles the nested `lavasr/`
// targets (flat engine targets resolve to `.`), so both coexist on device.
function buildPrestageScript(listB64, variant) {
  return `set -e
PRESTAGE_DIR=${PRESTAGE_DIR}
echo "${listB64}" | base64 -d > /tmp/prestage-list.tsv
adb shell mkdir -p "$PRESTAGE_DIR"
mkdir -p /tmp/prestage
while IFS=$(printf '\\t') read -r TARGET URL; do
  [ -z "$TARGET" ] && continue
  echo "[prestage] staging $TARGET (${variant})"
  mkdir -p "/tmp/prestage/$(dirname "$TARGET")"
  adb shell mkdir -p "$PRESTAGE_DIR/$(dirname "$TARGET")"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$TARGET" "$URL"
  adb push "/tmp/prestage/$TARGET" "$PRESTAGE_DIR/$TARGET"
  adb shell test -s "$PRESTAGE_DIR/$TARGET" || { echo "[prestage] FATAL: $TARGET missing after push"; exit 1; }
  rm -f "/tmp/prestage/$TARGET"
done < /tmp/prestage-list.tsv
echo "[prestage] device contents:"
adb shell ls -laR "$PRESTAGE_DIR" || true
echo "[prestage] done"`
}

function indentBlock(script) {
  return script
    .split('\n')
    .map((line) => '  ' + line)
    .join('\n')
}

function buildPrestageBlock(manifest, options) {
  const entries = selectEntries(manifest, options)
  const listB64 = Buffer.from(buildTsv(entries), 'utf8').toString('base64')
  return '|\n' + indentBlock(buildPrestageScript(listB64, options.variant)) + '\n'
}

function readOptionsFromEnv(env) {
  return {
    variant: resolveVariant(env.TTS_GGML_MOBILE_BENCHMARK_VARIANT),
    enhancer: env.TTS_GGML_MOBILE_BENCHMARK_ENHANCER || 'none',
    denoiser: env.TTS_GGML_MOBILE_BENCHMARK_DENOISER || 'none',
    quality: env.TTS_GGML_MOBILE_BENCHMARK_QUALITY !== 'false'
  }
}

function main() {
  const manifest = readManifest(MANIFEST_PATH)
  process.stdout.write(buildPrestageBlock(manifest, readOptionsFromEnv(process.env)))
}

if (require.main === module) {
  main()
}

module.exports = {
  ALLOWED_VARIANTS,
  PRESTAGE_DIR,
  resolveVariant,
  engineEntries,
  requestedLavasrKinds,
  lavasrEntries,
  qualityEntries,
  selectEntries,
  buildTsv,
  buildPrestageScript,
  buildPrestageBlock,
  readOptionsFromEnv
}
