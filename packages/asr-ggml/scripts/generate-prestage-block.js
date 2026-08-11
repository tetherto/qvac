'use strict'

const fs = require('fs')
const path = require('path')

const manifestPath = path.resolve(__dirname, '../test/mobile/testAssets/model-manifest.json')
const IOS_BUNDLE_ID = 'io.tether.test.qvac'

// Whisper models are public HuggingFace downloads, so they are prestaged from a
// local manifest here rather than through the presigned manifest that drives
// parakeet. The current shard selects entries from this manifest by runner name.
// Device-side pickup for these lives in test/integration/helpers.js
// (copyPrestagedModel), which requires the .size sidecar this block pushes
// alongside each model. Keep in sync with helpers.getTestPaths() and the
// whisper mobile-perf runners: ggml-tiny + Silero VAD cover the functional
// tests; the base/small q5_1/q8_0 quants cover the whisper mobile perf sweep.
const HF_WHISPER_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
const HF_VAD_BASE = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main'

const WHISPER_MODELS = [
  { name: 'ggml-tiny.bin', url: `${HF_WHISPER_BASE}/ggml-tiny.bin` },
  { name: 'ggml-silero-v5.1.2.bin', url: `${HF_VAD_BASE}/ggml-silero-v5.1.2.bin` },
  { name: 'ggml-base-q5_1.bin', url: `${HF_WHISPER_BASE}/ggml-base-q5_1.bin` },
  { name: 'ggml-base-q8_0.bin', url: `${HF_WHISPER_BASE}/ggml-base-q8_0.bin` },
  { name: 'ggml-small-q5_1.bin', url: `${HF_WHISPER_BASE}/ggml-small-q5_1.bin` },
  { name: 'ggml-small-q8_0.bin', url: `${HF_WHISPER_BASE}/ggml-small-q8_0.bin` }
]

const whisperByName = new Map(WHISPER_MODELS.map((model) => [model.name, model]))
const WHISPER_TEST_MODEL_NAMES = {
  runAccuracyMultilangTest: ['ggml-tiny.bin'],
  runAudioCtxChunkingTest: ['ggml-tiny.bin'],
  runColdStartTimingTest: ['ggml-tiny.bin', 'ggml-silero-v5.1.2.bin'],
  runCorruptedModelTest: ['ggml-tiny.bin'],
  runGpuTest: ['ggml-tiny.bin'],
  runLiveStreamSimulationTest: [],
  runLongESTest: ['ggml-tiny.bin'],
  runMobilePerfSweepCpuTest: [
    'ggml-base-q5_1.bin',
    'ggml-base-q8_0.bin',
    'ggml-small-q5_1.bin',
    'ggml-small-q8_0.bin'
  ],
  runMobilePerfTinyCpuTest: ['ggml-tiny.bin'],
  runModelFileValidationTest: ['ggml-tiny.bin', 'ggml-silero-v5.1.2.bin'],
  runMultipleTranscriptionsTest: ['ggml-tiny.bin'],
  runMobilePerfSweepGpuTest: [
    'ggml-base-q5_1.bin',
    'ggml-base-q8_0.bin',
    'ggml-small-q5_1.bin',
    'ggml-small-q8_0.bin'
  ],
  runMobilePerfTinyGpuTest: ['ggml-tiny.bin']
}

function buildWhisperManifest() {
  return Object.fromEntries(
    Object.entries(WHISPER_TEST_MODEL_NAMES).map(([testName, names]) => [
      testName,
      names.map((name) => whisperByName.get(name))
    ])
  )
}

// Whisper staging degrades gracefully: unlike parakeet's 600 MB-class GGUFs
// (fail-hard above), whisper's tiny/VAD/quant models are small enough to fetch
// on-device, so a host-side miss just warns and lets helpers.ensureWhisperModel
// download from HuggingFace. A .size sidecar is pushed next to each model so the
// device-side copy can reject a truncated push.
function buildWhisperStageFunction() {
  return `stage() {
  NAME="$1"; URL="$2"
  echo "[prestage] staging $NAME"
  adb shell rm -f "$PRESTAGE_DIR/$NAME" "$PRESTAGE_DIR/$NAME.size" || true
  if ! curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "$HOST_PRESTAGE_DIR/$NAME" "$URL"; then
    echo "[prestage] WARN: host download failed for $NAME; device will use network fallback"
    rm -f "$HOST_PRESTAGE_DIR/$NAME" "$HOST_PRESTAGE_DIR/$NAME.size"
    return 0
  fi
  if ! wc -c < "$HOST_PRESTAGE_DIR/$NAME" > "$HOST_PRESTAGE_DIR/$NAME.size"; then
    echo "[prestage] WARN: could not measure $NAME; device will use network fallback"
    rm -f "$HOST_PRESTAGE_DIR/$NAME" "$HOST_PRESTAGE_DIR/$NAME.size"
    return 0
  fi
  if ! adb push "$HOST_PRESTAGE_DIR/$NAME" "$PRESTAGE_DIR/$NAME"; then
    echo "[prestage] WARN: adb push failed for $NAME; device will use network fallback"
    adb shell rm -f "$PRESTAGE_DIR/$NAME" "$PRESTAGE_DIR/$NAME.size" || true
    rm -f "$HOST_PRESTAGE_DIR/$NAME" "$HOST_PRESTAGE_DIR/$NAME.size"
    return 0
  fi
  if ! adb push "$HOST_PRESTAGE_DIR/$NAME.size" "$PRESTAGE_DIR/$NAME.size"; then
    echo "[prestage] WARN: size metadata push failed for $NAME; device will use network fallback"
    adb shell rm -f "$PRESTAGE_DIR/$NAME" "$PRESTAGE_DIR/$NAME.size" || true
    rm -f "$HOST_PRESTAGE_DIR/$NAME" "$HOST_PRESTAGE_DIR/$NAME.size"
    return 0
  fi
  rm -f "$HOST_PRESTAGE_DIR/$NAME" "$HOST_PRESTAGE_DIR/$NAME.size"
}`
}

// iOS whisper staging mirrors the Android graceful-degrade contract but pushes
// into the app Documents/ container via pymobiledevice3. A push failure only
// warns (whisper models are small enough to fetch on-device), while the AFC
// failure-token regex + pinned pymobiledevice3 keep the guard from silently
// swallowing a real error. See buildIosScript for the pin/quirk rationale.
function buildIosWhisperStageFunction() {
  return `stage() {
  NAME="$1"; URL="$2"
  [ "$PRESTAGE_READY" = "1" ] || { echo "[prestage] WARN: iOS pre-stage unavailable for $NAME; device will use network fallback"; return 0; }
  echo "[prestage] staging $NAME"
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
  if PUSH_OUT=$(pymobiledevice3 apps push "$BID" "/tmp/prestage/$NAME" "Documents/$NAME" 2>&1); then PUSH_RC=0; else PUSH_RC=$?; fi
  printf '%s\\n' "$PUSH_OUT"
  if [ "$PUSH_RC" -ne 0 ] || printf '%s' "$PUSH_OUT" | grep -qiE "traceback|afcexception|not found during afc operation|failed to perform afc operation|failed with status|perm_denied|object_not_found|not permitted"; then
    echo "[prestage] WARN: push of $NAME failed (rc=$PUSH_RC); device will use network fallback"
    rm -f "/tmp/prestage/$NAME" "/tmp/prestage/$NAME.size"
    return 0
  fi
  if PUSH_OUT=$(pymobiledevice3 apps push "$BID" "/tmp/prestage/$NAME.size" "Documents/$NAME.size" 2>&1); then PUSH_RC=0; else PUSH_RC=$?; fi
  printf '%s\\n' "$PUSH_OUT"
  if [ "$PUSH_RC" -ne 0 ] || printf '%s' "$PUSH_OUT" | grep -qiE "traceback|afcexception|not found during afc operation|failed to perform afc operation|failed with status|perm_denied|object_not_found|not permitted"; then
    echo "[prestage] WARN: size metadata push failed for $NAME (rc=$PUSH_RC); device will use network fallback"
    rm -f "/tmp/prestage/$NAME" "/tmp/prestage/$NAME.size"
    return 0
  fi
  echo "[prestage] pushed $NAME -> Documents/$NAME"
  rm -f "/tmp/prestage/$NAME" "/tmp/prestage/$NAME.size"
}`
}

function buildIosWhisperStageBlock(models) {
  const stageCalls = models.map((m) => `stage "${m.name}" "${m.url}"`).join('\n')
  return `${buildIosWhisperStageFunction()}
${stageCalls}`
}

function buildWhisperStageBlock(models, platform = 'android') {
  const p = String(platform).toLowerCase()
  if (p === 'ios') return buildIosWhisperStageBlock(models)
  if (p === 'android') {
    const stageCalls = models.map((m) => `stage "${m.name}" "${m.url}"`).join('\n')
    return `${buildWhisperStageFunction()}
${stageCalls}`
  }
  throw new Error(`[prestage] unknown platform "${platform}" (expected 'android' or 'ios')`)
}

function selectPrestageModels() {
  const fs = require('fs')
  const path = require('path')
  const root = process.env.QVAC_PRESTAGE_TMP_DIR || '/tmp'
  const tests = (process.env.GREP || '')
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean)
  if (tests.length === 0) throw new Error('functional shard grep is required')

  const definitions = [
    { kind: 'parakeet', file: 'model-manifest.json' },
    { kind: 'whisper', file: 'whisper-manifest.json' }
  ]
  const manifests = Object.fromEntries(
    definitions.map(({ kind, file }) => {
      const value = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
      if (!value || Array.isArray(value) || typeof value !== 'object') {
        throw new Error(`invalid ${kind} manifest: expected an object`)
      }
      return [kind, value]
    })
  )
  const output = { parakeet: [], whisper: [] }
  const seen = { parakeet: new Map(), whisper: new Map() }

  for (const test of tests) {
    const matches = definitions.filter(({ kind }) =>
      Object.prototype.hasOwnProperty.call(manifests[kind], test)
    )
    if (matches.length === 0) throw new Error(`missing model mapping for runner: ${test}`)
    if (matches.length > 1) throw new Error(`ambiguous model mapping for runner: ${test}`)

    const kind = matches[0].kind
    const entries = manifests[kind][test]
    if (!Array.isArray(entries)) {
      throw new Error(`invalid ${kind} model mapping for runner ${test}: expected an array`)
    }
    for (const [index, model] of entries.entries()) {
      const invalid =
        !model ||
        Array.isArray(model) ||
        typeof model !== 'object' ||
        typeof model.name !== 'string' ||
        model.name.trim() === '' ||
        /[\t\r\n]/.test(model.name) ||
        typeof model.url !== 'string' ||
        model.url.trim() === '' ||
        /[\t\r\n]/.test(model.url)
      if (invalid) {
        throw new Error(`invalid ${kind} model mapping for runner ${test} at index ${index}`)
      }

      const previousUrl = seen[kind].get(model.name)
      if (previousUrl && previousUrl !== model.url) {
        throw new Error(`conflicting URLs for ${kind} model ${model.name}`)
      }
      if (!previousUrl) {
        seen[kind].set(model.name, model.url)
        output[kind].push(`${model.name}\t${model.url}`)
      }
    }
  }

  for (const kind of ['parakeet', 'whisper']) {
    const rows = output[kind]
    fs.writeFileSync(
      path.join(root, `${kind}-prestage-list.tsv`),
      rows.join('\n') + (rows.length ? '\n' : '')
    )
  }
  console.error(
    `[prestage] ${output.parakeet.length} parakeet + ${output.whisper.length} ` +
      `whisper model(s) for ${tests.length} test(s)`
  )
}

function buildSelectionCode() {
  return `(${selectPrestageModels.toString()})()`
}

// Parakeet block: presigned-S3 GGUFs resolved from the manifest by the explicit
// shard grep, staged fail-hard (a missing 600 MB-class model on-device would
// blow the mocha budget). Whisper block appended after, staged gracefully.
function buildAndroidScript(manifestB64) {
  const whisperManifestB64 = Buffer.from(JSON.stringify(buildWhisperManifest()), 'utf8').toString(
    'base64'
  )
  const selectionCodeB64 = Buffer.from(buildSelectionCode(), 'utf8').toString('base64')
  return `set -euo pipefail
PRESTAGE_DIR=/data/local/tmp/prestaged-models
TMP_ROOT="\${QVAC_PRESTAGE_TMP_DIR:-/tmp}"
HOST_PRESTAGE_DIR="$TMP_ROOT/prestage"
adb shell mkdir -p "$PRESTAGE_DIR"
mkdir -p "$HOST_PRESTAGE_DIR"
echo "${manifestB64}" | base64 -d > "$TMP_ROOT/model-manifest.json"
echo "${whisperManifestB64}" | base64 -d > "$TMP_ROOT/whisper-manifest.json"
echo "${selectionCodeB64}" | base64 -d > "$TMP_ROOT/select-prestage-models.js"
GREP=$(cat "$TMP_ROOT/qvacShardGrep.txt")
export GREP
echo "[prestage] shard grep: '$GREP'"
[ -n "$GREP" ] || { echo "[prestage] FATAL: shard grep is required"; exit 1; }
node "$TMP_ROOT/select-prestage-models.js"
while IFS=$'\\t' read -r NAME URL; do
  if [ -z "$NAME" ]; then
    continue
  fi
  echo "[prestage] staging required parakeet model $NAME"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "$HOST_PRESTAGE_DIR/$NAME" "$URL"
  adb push "$HOST_PRESTAGE_DIR/$NAME" "$PRESTAGE_DIR/$NAME"
  adb shell test -s "$PRESTAGE_DIR/$NAME" || { echo "[prestage] FATAL: $NAME not present on device after push"; exit 1; }
  rm -f "$HOST_PRESTAGE_DIR/$NAME"
done < "$TMP_ROOT/parakeet-prestage-list.tsv"
${buildWhisperStageFunction()}
while IFS=$'\\t' read -r NAME URL; do
  if [ -z "$NAME" ]; then
    continue
  fi
  stage "$NAME" "$URL"
done < "$TMP_ROOT/whisper-prestage-list.tsv"
echo "[prestage] device contents:"
adb shell ls -la "$PRESTAGE_DIR" || true
echo "[prestage] done"`
}

// iOS mirrors the Android buildScript contract exactly — same explicit shard
// grep (/tmp/qvacShardGrep.txt) and the same selectPrestageModels() split that
// shard-selects Parakeet (fail-hard) and Whisper (graceful) — only the push
// transport differs: pymobiledevice3 apps push into the app Documents/ container
// instead of adb. The push guard fails closed via a non-zero exit or the AFC
// failure-token regex, and pymobiledevice3 is pinned to ==10.3.1 (an unpinned
// --upgrade can otherwise resolve an older CLI that logs AFC errors but exits 0).
function buildIosScript(manifestB64) {
  const whisperManifestB64 = Buffer.from(JSON.stringify(buildWhisperManifest()), 'utf8').toString(
    'base64'
  )
  const selectionCodeB64 = Buffer.from(buildSelectionCode(), 'utf8').toString('base64')
  return `set -e
export PATH="$HOME/.local/bin:$PATH"
unset SUDO_UID SUDO_GID
BID=${IOS_BUNDLE_ID}
TMP_ROOT="\${QVAC_PRESTAGE_TMP_DIR:-/tmp}"
PRESTAGE_READY=1
mkdir -p /tmp/prestage
echo "${manifestB64}" | base64 -d > "$TMP_ROOT/model-manifest.json"
echo "${whisperManifestB64}" | base64 -d > "$TMP_ROOT/whisper-manifest.json"
echo "${selectionCodeB64}" | base64 -d > "$TMP_ROOT/select-prestage-models.js"
GREP=$(cat "$TMP_ROOT/qvacShardGrep.txt")
export GREP
echo "[prestage] shard grep: '$GREP'"
[ -n "$GREP" ] || { echo "[prestage] FATAL: shard grep is required"; exit 1; }
if ! (python3 -m pip install --quiet --upgrade pymobiledevice3==10.3.1 || pip3 install --quiet --upgrade pymobiledevice3==10.3.1 || python3 -m pip install --quiet --upgrade --break-system-packages pymobiledevice3==10.3.1); then
  echo "[prestage] WARN: pymobiledevice3 install failed; whisper will use network fallback"
  PRESTAGE_READY=0
fi
if [ "$PRESTAGE_READY" = "1" ] && ! pymobiledevice3 version >/dev/null 2>&1; then
  echo "[prestage] WARN: pymobiledevice3 not runnable; whisper will use network fallback"
  PRESTAGE_READY=0
fi
node "$TMP_ROOT/select-prestage-models.js"
if [ "$PRESTAGE_READY" != "1" ] && [ -s "$TMP_ROOT/parakeet-prestage-list.tsv" ]; then
  echo "[prestage] FATAL: pymobiledevice3 unavailable for parakeet pre-stage"; exit 1
fi
if [ "$PRESTAGE_READY" = "1" ]; then
  while IFS=$(printf '\\t') read -r NAME URL; do
    [ -z "$NAME" ] && continue
    echo "[prestage] staging required parakeet model $NAME"
    curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$NAME" "$URL"
    if PUSH_OUT=$(pymobiledevice3 apps push "$BID" "/tmp/prestage/$NAME" "Documents/$NAME" 2>&1); then PUSH_RC=0; else PUSH_RC=$?; fi
    printf '%s\\n' "$PUSH_OUT"
    if [ "$PUSH_RC" -ne 0 ] || printf '%s' "$PUSH_OUT" | grep -qiE "traceback|afcexception|not found during afc operation|failed to perform afc operation|failed with status|perm_denied|object_not_found|not permitted"; then
      echo "[prestage] FATAL: push of $NAME failed (rc=$PUSH_RC; see AFC error above)"; exit 1
    fi
    echo "[prestage] pushed $NAME -> Documents/$NAME"
    rm -f "/tmp/prestage/$NAME"
  done < "$TMP_ROOT/parakeet-prestage-list.tsv"
fi
${buildIosWhisperStageFunction()}
while IFS=$(printf '\\t') read -r NAME URL; do
  [ -z "$NAME" ] && continue
  stage "$NAME" "$URL"
done < "$TMP_ROOT/whisper-prestage-list.tsv"
echo "[prestage] done"`
}

function buildScript(manifestB64, platform = 'android') {
  const p = String(platform).toLowerCase()
  if (p === 'ios') return buildIosScript(manifestB64)
  if (p === 'android') return buildAndroidScript(manifestB64)
  throw new Error(`[prestage] unknown platform "${platform}" (expected 'android' or 'ios')`)
}

function main() {
  const platform = process.argv[2] || 'android'
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      'Missing test/mobile/testAssets/model-manifest.json. Run scripts/generate-mobile-model-manifest.js first.'
    )
  }

  const manifestB64 = Buffer.from(fs.readFileSync(manifestPath)).toString('base64')
  const script = buildScript(manifestB64, platform)

  const body = script
    .split('\n')
    .map((line) => '  ' + line)
    .join('\n')

  process.stdout.write('|\n' + body + '\n')
}

if (require.main === module) main()

module.exports = {
  WHISPER_MODELS,
  WHISPER_TEST_MODEL_NAMES,
  buildWhisperManifest,
  buildWhisperStageBlock,
  buildSelectionCode,
  buildScript,
  IOS_BUNDLE_ID
}
