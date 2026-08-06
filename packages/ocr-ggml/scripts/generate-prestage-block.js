'use strict'
// Emits the ocr-ggml mobile workflow's `extra-pre-test-commands` value: a host
// script (run in the Device Farm pre_test phase) that downloads the OCR GGUF
// models on the host's reliable network and adb-pushes them to
// /data/local/tmp/prestaged-models, so the phone doesn't fetch them from
// presigned S3. ocr-ggml is sharded, but there are only four small models and
// the composite injects the same block into every shard, so we stage all four
// on each device rather than maintaining a per-shard map. The presigned URLs are
// written to ocr-ggml-model-urls.json by generate-ocr-ggml-presigned-urls.sh
// before this runs. Device-side pickup lives in test/integration/utils.js.

const fs = require('fs')
const path = require('path')

const DEFAULT_ASSETS_DIR = path.resolve(__dirname, '../test/mobile/testAssets')

// filename on device  <->  key in ocr-ggml-model-urls.json
const MODEL_KEYS = [
  { name: 'craft_mlt_25k.gguf', key: 'craft_mlt_25k_url' },
  { name: 'latin_g2.gguf', key: 'latin_g2_url' },
  { name: 'db_mobilenet_v3_large.gguf', key: 'db_mobilenet_v3_large_url' },
  { name: 'crnn_mobilenet_v3_small.gguf', key: 'crnn_mobilenet_v3_small_url' }
]

// Returns only entries with a usable https URL; [] when the config is absent so
// the caller emits an empty block.
function readModels(assetsDir = DEFAULT_ASSETS_DIR) {
  const configPath = path.join(assetsDir, 'ocr-ggml-model-urls.json')
  if (!fs.existsSync(configPath)) return []
  let config
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (_) {
    return []
  }
  const models = []
  for (const { name, key } of MODEL_KEYS) {
    const url = config[key]
    if (typeof url === 'string' && url.startsWith('https://')) {
      models.push({ name, url })
    }
  }
  return models
}

function buildScript(models) {
  const stageCalls = models.map((m) => `stage "${m.name}" "${m.url}"`).join('\n')
  return `set -e
PRESTAGE_DIR=/data/local/tmp/prestaged-models
PRESTAGE_READY=1
if ! adb shell mkdir -p "$PRESTAGE_DIR"; then
  echo "[prestage] WARN: adb setup failed; device will use network fallback"
  PRESTAGE_READY=0
fi
if ! mkdir -p /tmp/prestage; then
  echo "[prestage] WARN: host temp setup failed; device will use network fallback"
  PRESTAGE_READY=0
fi
stage() {
  NAME="$1"; URL="$2"
  [ "$PRESTAGE_READY" = "1" ] || return 0
  echo "[prestage] staging $NAME"
  adb shell rm -f "$PRESTAGE_DIR/$NAME" "$PRESTAGE_DIR/$NAME.size" || true
  if ! curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$NAME" "$URL"; then
    echo "[prestage] WARN: host download failed for $NAME; device will use network fallback"
    rm -f "/tmp/prestage/$NAME" "/tmp/prestage/$NAME.size"
    return 0
  fi
  if ! wc -c < "/tmp/prestage/$NAME" > "/tmp/prestage/$NAME.size"; then
    echo "[prestage] WARN: could not measure $NAME; device will use network fallback"
    rm -f "/tmp/prestage/$NAME" "/tmp/prestage/$NAME.size"
    return 0
  fi
  if ! adb push "/tmp/prestage/$NAME" "$PRESTAGE_DIR/$NAME"; then
    echo "[prestage] WARN: adb push failed for $NAME; device will use network fallback"
    adb shell rm -f "$PRESTAGE_DIR/$NAME" "$PRESTAGE_DIR/$NAME.size" || true
    rm -f "/tmp/prestage/$NAME" "/tmp/prestage/$NAME.size"
    return 0
  fi
  if ! adb push "/tmp/prestage/$NAME.size" "$PRESTAGE_DIR/$NAME.size"; then
    echo "[prestage] WARN: size metadata push failed for $NAME; device will use network fallback"
    adb shell rm -f "$PRESTAGE_DIR/$NAME" "$PRESTAGE_DIR/$NAME.size" || true
    rm -f "/tmp/prestage/$NAME" "/tmp/prestage/$NAME.size"
    return 0
  fi
  rm -f "/tmp/prestage/$NAME" "/tmp/prestage/$NAME.size"
}
${stageCalls}
echo "[prestage] device contents:"
adb shell ls -la "$PRESTAGE_DIR" || true
echo "[prestage] done"`
}

function formatYamlBlock(script) {
  const body = script
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  return '|\n' + body + '\n'
}

function main() {
  const models = readModels()
  if (models.length === 0) {
    console.error('[prestage] no ocr-ggml-model-urls.json found — skipping pre-stage')
    return
  }
  console.error(
    `[prestage] staging ${models.length} model(s): ${models.map((m) => m.name).join(', ')}`
  )
  // generate-testspec.sh treats a lone "|" line as a YAML literal block whose
  // body lines are indented by 2 spaces.
  process.stdout.write(formatYamlBlock(buildScript(models)))
}

if (require.main === module) main()

module.exports = { MODEL_KEYS, readModels, buildScript, formatYamlBlock }
