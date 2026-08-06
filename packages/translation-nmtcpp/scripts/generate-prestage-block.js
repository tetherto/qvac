'use strict'
// Emits the translation-nmtcpp mobile workflow's `extra-pre-test-commands`
// value: a host script (run in the Device Farm pre_test phase) that downloads
// the ~127MB IndicTrans model on the host's reliable network and adb-pushes it
// to /data/local/tmp/prestaged-models, so the phone doesn't fetch it from the
// flaky presigned-S3 source (the source of the Samsung Galaxy S25 Ultra
// CONNECTION_LOST → SIGABRT failures). provision-mobile-models.sh writes the
// presigned URL to indictrans-model-urls.json before this runs; we bake it in.
// Device-side pickup lives in test/integration/utils.js.
//
// Bergamot is intentionally NOT staged: its Firefox-CDN fetcher pulls a set of
// files (model + vocab + lex) and skips re-download when only .intgemm/.spm
// exist, so a partial stage would break it; it also uses a public CDN, not the
// flaky S3 path.

const fs = require('fs')
const path = require('path')

const INDICTRANS_MODEL_NAME = 'ggml-indictrans2-en-indic-dist-200M-q4_0.bin'
const DEFAULT_ASSETS_DIR = path.resolve(__dirname, '../test/mobile/testAssets')

// Returns [] when the config is absent so the caller emits an empty block and
// the phone falls back to downloading.
function readIndicTransModels(assetsDir = DEFAULT_ASSETS_DIR) {
  const configPath = path.join(assetsDir, 'indictrans-model-urls.json')
  if (!fs.existsSync(configPath)) return []
  let config
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (_) {
    return []
  }
  if (!config || typeof config.modelUrl !== 'string' || !config.modelUrl.startsWith('https://')) {
    return []
  }
  return [{ name: INDICTRANS_MODEL_NAME, url: config.modelUrl }]
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
  const models = readIndicTransModels()
  if (models.length === 0) {
    console.error('[prestage] no indictrans-model-urls.json found — skipping pre-stage')
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

module.exports = {
  INDICTRANS_MODEL_NAME,
  readIndicTransModels,
  buildScript,
  formatYamlBlock
}
