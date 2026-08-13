'use strict'
// Emit the YAML value for the embed mobile workflow's `extra-pre-test-commands`
// input: a host script (run in the Device Farm pre_test phase, where the network
// is reliable) that pre-stages ALL embed test models onto the device at
// /data/local/tmp/prestaged-models, so the phone never downloads from
// huggingface.co (QVAC-21799). Embed runs single-pool (all tests on one
// device), so there is no per-shard selection — every model in
// test/integration/models.manifest.json is staged. The device-side pickup lives
// in test/integration/utils.js.
//
// Run `node scripts/generate-prestage-block.js [android|ios]` and paste the
// output under `extra-pre-test-commands:` (indented), or wire it via a workflow
// step (see integration-mobile-test-embed-llamacpp.yml).
const fs = require('fs')
const path = require('path')

const manifestPath = path.resolve(__dirname, '../test/integration/models.manifest.json')
const IOS_BUNDLE_ID = 'io.tether.test.qvac'

function modelsFromManifest(manifest) {
  if (!manifest || !manifest.models) {
    throw new Error('[prestage] integration model manifest has no models')
  }
  const models = []
  for (const [name, entry] of Object.entries(manifest.models)) {
    const url = entry && Array.isArray(entry.urls) ? entry.urls[0] : null
    if (
      typeof url !== 'string' ||
      !url.startsWith('https://') ||
      /\/resolve\/(?:main|master)\//.test(url)
    ) {
      throw new Error(`[prestage] ${name} has no usable pinned manifest URL`)
    }
    models.push({ name, url })
  }
  return models
}

// Host script. POSIX-sh friendly; adb + curl are available in the pre_test phase.
function buildAndroidScript(models) {
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

function buildIosScript(models) {
  const stageCalls = models.map((m) => `stage "${m.name}" "${m.url}"`).join('\n')
  return `set -e
export PATH="$HOME/.local/bin:$PATH"
unset SUDO_UID SUDO_GID
BID=${IOS_BUNDLE_ID}
echo "[prestage] installing pymobiledevice3..."
python3 -m pip install --quiet --upgrade pymobiledevice3==10.3.1 || pip3 install --quiet --upgrade pymobiledevice3==10.3.1 || python3 -m pip install --quiet --upgrade --break-system-packages pymobiledevice3==10.3.1 || { echo "[prestage] FATAL: pymobiledevice3 install failed"; exit 1; }
pymobiledevice3 version >/dev/null 2>&1 || { echo "[prestage] FATAL: pymobiledevice3 not runnable"; exit 1; }
mkdir -p /tmp/prestage
stage() {
  NAME="$1"; URL="$2"
  echo "[prestage] staging $NAME"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$NAME" "$URL"
  if PUSH_OUT=$(pymobiledevice3 apps push "$BID" "/tmp/prestage/$NAME" "Documents/$NAME" 2>&1); then PUSH_RC=0; else PUSH_RC=$?; fi
  printf '%s\\n' "$PUSH_OUT"
  if [ "$PUSH_RC" -ne 0 ] || printf '%s' "$PUSH_OUT" | grep -qiE "traceback|afcexception|not found during afc operation|failed to perform afc operation|failed with status|perm_denied|object_not_found|not permitted"; then
    echo "[prestage] FATAL: push of $NAME failed (rc=$PUSH_RC; see AFC error above)"; exit 1
  fi
  echo "[prestage] pushed $NAME -> Documents/$NAME"
  rm -f "/tmp/prestage/$NAME"
}
${stageCalls}
echo "[prestage] done"`
}

function buildScript(models, platform = 'android') {
  const p = String(platform).toLowerCase()
  if (p === 'ios') return buildIosScript(models)
  if (p === 'android') return buildAndroidScript(models)
  throw new Error(`[prestage] unknown platform "${platform}" (expected 'android' or 'ios')`)
}

function main() {
  const platform = process.argv[2] || 'android'
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const models = modelsFromManifest(manifest)
  if (models.length === 0) {
    console.error('[prestage] no models found in models.manifest.json')
    process.exit(1)
  }
  console.error(
    `[prestage] staging ${models.length} model(s): ${models.map((m) => m.name).join(', ')}`
  )
  // emit_extra_commands in generate-testspec.sh treats a lone "|" line as the
  // start of a YAML literal block whose body lines are indented by 2 spaces.
  const body = buildScript(models, platform)
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  process.stdout.write('|\n' + body + '\n')
}

if (require.main === module) main()

module.exports = { modelsFromManifest, buildScript, IOS_BUNDLE_ID }
