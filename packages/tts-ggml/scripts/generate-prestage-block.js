'use strict'

const fs = require('fs')
const path = require('path')

const MANIFEST_PATH = path.resolve(__dirname, '../test/mobile/testAssets/model-manifest.json')
const PRESTAGE_DIR = '/data/local/tmp/qvac-tts-ggml/models'
// iOS stages into the app's Documents container (dev-signed get-task-allow app),
// exposed on-device as global.testDir. The resolver in test/utils/downloadModel.js
// already scans global.testDir/models (engine), .../models/lavasr (enhancer +
// denoiser) and .../models/whisper (quality), so pushing each manifest target
// under Documents/models/<target> is picked up with no on-device download and no
// resolver change. AFC (pymobiledevice3 apps push) creates parent dirs.
const IOS_MODELS_ROOT = 'Documents/models'
const IOS_BUNDLE_ID = 'io.tether.test.qvac'
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

// iOS host script for the macOS Device Farm host. Mirrors the Android flow but
// stages into the app's Documents container via pymobiledevice3 instead of adb.
// Two host-environment quirks, both proven on Device Farm iOS:
//   1. The pre_test phase runs under sudo, so SUDO_UID/SUDO_GID are set and
//      pymobiledevice3 aborts trying to chown ~/.pymobiledevice3 (EPERM).
//      Unsetting them makes it skip the chown.
//   2. `apps push` can exit 0 while logging an AFC error, so success is NOT
//      inferred from the exit code alone — fail hard on a non-zero exit OR a
//      specific AFC/Python failure token (mirrors Android's `adb shell test -s`).
// `apps push` uses AfcService.push, which creates parent dirs, so the nested
// lavasr/ and whisper/ targets need no explicit mkdir on the device.
function buildIosPrestageScript(listB64, variant) {
  return `set -e
export PATH="$HOME/.local/bin:$PATH"
unset SUDO_UID SUDO_GID
BID=${IOS_BUNDLE_ID}
MODELS_ROOT=${IOS_MODELS_ROOT}
echo "[prestage] installing pymobiledevice3..."
python3 -m pip install --quiet --upgrade pymobiledevice3 || pip3 install --quiet --upgrade pymobiledevice3 || python3 -m pip install --quiet --upgrade --break-system-packages pymobiledevice3 || { echo "[prestage] FATAL: pymobiledevice3 install failed"; exit 1; }
pymobiledevice3 version >/dev/null 2>&1 || { echo "[prestage] FATAL: pymobiledevice3 not runnable"; exit 1; }
echo "${listB64}" | base64 -d > /tmp/prestage-list.tsv
mkdir -p /tmp/prestage
while IFS=$(printf '\\t') read -r TARGET URL; do
  [ -z "$TARGET" ] && continue
  echo "[prestage] staging $TARGET (${variant})"
  mkdir -p "/tmp/prestage/$(dirname "$TARGET")"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$TARGET" "$URL"
  if PUSH_OUT=$(pymobiledevice3 apps push "$BID" "/tmp/prestage/$TARGET" "$MODELS_ROOT/$TARGET" 2>&1); then PUSH_RC=0; else PUSH_RC=$?; fi
  printf '%s\\n' "$PUSH_OUT"
  if [ "$PUSH_RC" -ne 0 ] || printf '%s' "$PUSH_OUT" | grep -qiE "traceback|afcexception|failed with status|perm_denied|object_not_found|not permitted"; then
    echo "[prestage] FATAL: push of $TARGET failed (rc=$PUSH_RC; see AFC error above)"; exit 1
  fi
  echo "[prestage] pushed $TARGET -> $MODELS_ROOT/$TARGET"
  rm -f "/tmp/prestage/$TARGET"
done < /tmp/prestage-list.tsv
echo "[prestage] done"`
}

function indentBlock(script) {
  return script
    .split('\n')
    .map((line) => '  ' + line)
    .join('\n')
}

function buildPlatformScript(listB64, variant, platform) {
  const p = String(platform).toLowerCase()
  if (p === 'ios') return buildIosPrestageScript(listB64, variant)
  if (p === 'android') return buildPrestageScript(listB64, variant)
  throw new Error(`[prestage] unknown platform "${platform}" (expected 'android' or 'ios')`)
}

function buildPrestageBlock(manifest, options, platform = 'android') {
  const entries = selectEntries(manifest, options)
  const listB64 = Buffer.from(buildTsv(entries), 'utf8').toString('base64')
  return '|\n' + indentBlock(buildPlatformScript(listB64, options.variant, platform)) + '\n'
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
  const platform = process.argv[2] || 'android'
  const manifest = readManifest(MANIFEST_PATH)
  process.stdout.write(buildPrestageBlock(manifest, readOptionsFromEnv(process.env), platform))
}

if (require.main === module) {
  main()
}

module.exports = {
  ALLOWED_VARIANTS,
  PRESTAGE_DIR,
  IOS_MODELS_ROOT,
  IOS_BUNDLE_ID,
  resolveVariant,
  engineEntries,
  requestedLavasrKinds,
  lavasrEntries,
  qualityEntries,
  selectEntries,
  buildTsv,
  buildPrestageScript,
  buildIosPrestageScript,
  buildPlatformScript,
  buildPrestageBlock,
  readOptionsFromEnv
}
