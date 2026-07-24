'use strict'
// Emit the YAML value for the ocr-ggml mobile workflow's
// `extra-pre-test-commands` input: a host script (run in the Device Farm
// pre_test phase, where the network is reliable) that pre-stages the OCR GGUF
// models onto the device at /data/local/tmp/prestaged-models, so the phone never
// downloads them from presigned S3 during the test phase (QVAC-21799).
//
// ocr-ggml runs SHARDED (perf / regularA / regularB), but there are only four
// small GGUF models total and the composite injects this same block into every
// shard's testspec, so we simply stage all four on each device rather than
// maintaining a per-shard test->model map. The device-side pickup lives in
// test/integration/utils.js (copyPrestagedModel in ensureModelPath /
// ensureDoctrModels).
//
// The presigned URLs are produced on the runner by
// scripts/generate-ocr-ggml-presigned-urls.sh (writes
// test/mobile/testAssets/ocr-ggml-model-urls.json) BEFORE this script runs, so
// we read them back and bake them into the emitted host script. Keys mirror
// ensureModelPath / ensureDoctrModels in test/integration/utils.js.

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

// Read the presigned URLs bundled by generate-ocr-ggml-presigned-urls.sh.
// Returns only the entries with a usable https URL; [] when the config is absent
// (e.g. provisioning did not run) so the caller can emit an empty block.
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

// Host script. POSIX-sh friendly; adb + curl are available in the pre_test phase.
function buildScript(models) {
  const stageCalls = models.map((m) => `stage "${m.name}" "${m.url}"`).join('\n')
  return `set -e
PRESTAGE_DIR=/data/local/tmp/prestaged-models
adb shell mkdir -p "$PRESTAGE_DIR"
mkdir -p /tmp/prestage
stage() {
  NAME="$1"; URL="$2"
  echo "[prestage] staging $NAME"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$NAME" "$URL"
  adb push "/tmp/prestage/$NAME" "$PRESTAGE_DIR/$NAME"
  adb shell test -s "$PRESTAGE_DIR/$NAME" || { echo "[prestage] FATAL: $NAME not present on device after push"; exit 1; }
  rm -f "/tmp/prestage/$NAME"
}
${stageCalls}
echo "[prestage] device contents:"
adb shell ls -la "$PRESTAGE_DIR" || true
echo "[prestage] done"`
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
  // emit_extra_commands in generate-testspec.sh treats a lone "|" line as the
  // start of a YAML literal block whose body lines are indented by 2 spaces.
  const body = buildScript(models)
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  process.stdout.write('|\n' + body + '\n')
}

if (require.main === module) main()

module.exports = { MODEL_KEYS, readModels, buildScript }
