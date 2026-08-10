'use strict'

const fs = require('fs')
const path = require('path')

const manifestPath = path.resolve(__dirname, '../test/mobile/testAssets/model-manifest.json')

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

function buildWhisperStageBlock(models) {
  const stageCalls = models.map((m) => `stage "${m.name}" "${m.url}"`).join('\n')
  return `${buildWhisperStageFunction()}
${stageCalls}`
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
function buildScript(manifestB64) {
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

function main() {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      'Missing test/mobile/testAssets/model-manifest.json. Run scripts/generate-mobile-model-manifest.js first.'
    )
  }

  const manifestB64 = Buffer.from(fs.readFileSync(manifestPath)).toString('base64')
  const script = buildScript(manifestB64)

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
  buildScript
}
