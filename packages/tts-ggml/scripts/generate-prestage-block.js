'use strict'

const fs = require('fs')
const path = require('path')

const manifestPath = path.resolve(__dirname, '../test/mobile/testAssets/model-manifest.json')

if (!fs.existsSync(manifestPath)) {
  throw new Error('Missing test/mobile/testAssets/model-manifest.json. Run scripts/generate-mobile-model-manifest.js first.')
}

const variantRaw = (process.env.TTS_GGML_MOBILE_BENCHMARK_VARIANT || 'q4').toLowerCase()
const allowedVariants = ['q4', 'q8']
if (!allowedVariants.includes(variantRaw)) {
  throw new Error(`Unsupported variant "${variantRaw}". Expected one of: ${allowedVariants.join(', ')}`)
}
const variant = variantRaw

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const entries = Array.isArray(manifest[variant]) ? manifest[variant] : []
if (entries.length === 0) {
  throw new Error(`No manifest entries found for variant "${variant}"`)
}

const listTsv = entries
  .map((entry) => `${entry.targetName}\t${entry.url}`)
  .join('\n') + '\n'

const listB64 = Buffer.from(listTsv, 'utf8').toString('base64')

const script = `set -e
PRESTAGE_DIR=/data/local/tmp/qvac-tts-ggml/models
echo "${listB64}" | base64 -d > /tmp/prestage-list.tsv
adb shell mkdir -p "$PRESTAGE_DIR"
mkdir -p /tmp/prestage
while IFS=$(printf '\\t') read -r TARGET URL; do
  [ -z "$TARGET" ] && continue
  echo "[prestage] staging $TARGET (${variant})"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$TARGET" "$URL"
  adb push "/tmp/prestage/$TARGET" "$PRESTAGE_DIR/$TARGET"
  adb shell test -s "$PRESTAGE_DIR/$TARGET" || { echo "[prestage] FATAL: $TARGET missing after push"; exit 1; }
  rm -f "/tmp/prestage/$TARGET"
done < /tmp/prestage-list.tsv
echo "[prestage] device contents:"
adb shell ls -la "$PRESTAGE_DIR" || true
echo "[prestage] done"`

const body = script
  .split('\n')
  .map((line) => '  ' + line)
  .join('\n')

process.stdout.write('|\n' + body + '\n')
