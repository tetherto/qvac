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
}`
}

function buildWhisperStageBlock(models) {
  const stageCalls = models.map((m) => `stage "${m.name}" "${m.url}"`).join('\n')
  return `${buildWhisperStageFunction()}
${stageCalls}`
}

// Parakeet block: presigned-S3 GGUFs resolved from the manifest by the explicit
// shard grep, staged fail-hard (a missing 600 MB-class model on-device would
// blow the mocha budget). Whisper block appended after, staged gracefully.
function buildScript(manifestB64) {
  const whisperManifestB64 = Buffer.from(JSON.stringify(buildWhisperManifest()), 'utf8').toString(
    'base64'
  )
  return `set -euo pipefail
PRESTAGE_DIR=/data/local/tmp/prestaged-models
adb shell mkdir -p "$PRESTAGE_DIR"
mkdir -p /tmp/prestage
echo "${manifestB64}" | base64 -d > /tmp/model-manifest.json
echo "${whisperManifestB64}" | base64 -d > /tmp/whisper-manifest.json
GREP=$(cat /tmp/qvacShardGrep.txt)
export GREP
echo "[prestage] shard grep: '$GREP'"
[ -n "$GREP" ] || { echo "[prestage] FATAL: shard grep is required"; exit 1; }
node -e "const fs=require('fs');const tests=process.env.GREP.split('|').map(s=>s.trim()).filter(Boolean);const select=(path)=>{const man=JSON.parse(fs.readFileSync(path,'utf8'));const seen=new Set();const out=[];for(const t of tests){for(const m of (man[t]||[])){if(!seen.has(m.name)){seen.add(m.name);out.push(m.name+'\\t'+m.url)}}}return out};const write=(path,rows)=>fs.writeFileSync(path,rows.join('\\n')+(rows.length?'\\n':''));const parakeet=select('/tmp/model-manifest.json');const whisper=select('/tmp/whisper-manifest.json');write('/tmp/parakeet-prestage-list.tsv',parakeet);write('/tmp/whisper-prestage-list.tsv',whisper);console.error('[prestage] '+parakeet.length+' parakeet + '+whisper.length+' whisper model(s) for '+tests.length+' test(s)')"
while IFS=$(printf '\\t') read -r NAME URL; do
  [ -z "$NAME" ] && continue
  echo "[prestage] staging required parakeet model $NAME"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$NAME" "$URL"
  adb push "/tmp/prestage/$NAME" "$PRESTAGE_DIR/$NAME"
  adb shell test -s "$PRESTAGE_DIR/$NAME" || { echo "[prestage] FATAL: $NAME not present on device after push"; exit 1; }
  rm -f "/tmp/prestage/$NAME"
done < /tmp/parakeet-prestage-list.tsv
${buildWhisperStageFunction()}
while IFS=$(printf '\\t') read -r NAME URL; do
  [ -z "$NAME" ] && continue
  stage "$NAME" "$URL"
done < /tmp/whisper-prestage-list.tsv
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
  buildScript
}
