'use strict'
// Emit the YAML value for the translation-nmtcpp mobile workflow's
// `extra-pre-test-commands` input: a host script (run in the Device Farm
// pre_test phase, where the network is reliable) that pre-stages the IndicTrans
// model onto the device at /data/local/tmp/prestaged-models, so the phone never
// downloads the ~127MB model from the (flaky, presigned-S3) source during the
// test phase — the documented root cause of the Samsung Galaxy S25 Ultra
// CONNECTION_LOST → SIGABRT failures (QVAC-21799).
//
// translation-nmtcpp runs single-pool (all tests on one device), so there is no
// per-shard selection. The presigned URL is produced on the runner by
// scripts/provision-mobile-models.sh (writes test/mobile/testAssets/
// indictrans-model-urls.json) BEFORE this script runs, so we read it back and
// bake it into the emitted host script.
//
// Bergamot is intentionally NOT pre-staged here: its Firefox-CDN fetcher
// downloads a *set* of files (model + vocab + lex) and skips re-download when
// only .intgemm + .spm are present, so a partial stage from bergamot-urls.json
// (model + vocab only) would leave lex missing and break the test. Bergamot also
// uses a public CDN, not the flaky S3 path. Left as a follow-up.
//
// The device-side pickup lives in test/integration/utils.js
// (prestagedModelPath / copyPrestagedModel in ensureIndicTransModel).

const fs = require('fs')
const path = require('path')

const INDICTRANS_MODEL_NAME = 'ggml-indictrans2-en-indic-dist-200M-q4_0.bin'
const DEFAULT_ASSETS_DIR = path.resolve(__dirname, '../test/mobile/testAssets')

// Read the presigned IndicTrans URL that provision-mobile-models.sh bundled.
// Returns null when the config is absent (e.g. provisioning did not run) so the
// caller can emit an empty block and let the phone fall back to downloading.
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
  const models = readIndicTransModels()
  if (models.length === 0) {
    // No config → emit nothing. The workflow input stays empty and the phone
    // downloads as before (graceful degradation, never blocks the run).
    console.error('[prestage] no indictrans-model-urls.json found — skipping pre-stage')
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

module.exports = { INDICTRANS_MODEL_NAME, readIndicTransModels, buildScript }
