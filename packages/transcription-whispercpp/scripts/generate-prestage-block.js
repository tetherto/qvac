'use strict'
// Emits the whisper mobile workflow's `extra-pre-test-commands` value: a host
// script (run in the Device Farm pre_test phase) that downloads the mobile
// models on the host's reliable network and adb-pushes them to
// /data/local/tmp/prestaged-models, so the phone doesn't fetch them itself.
// Single-pool, so all models are staged. Device-side pickup lives in
// test/integration/helpers.js. Keep this list in sync with getTestPaths() there.

const HF_WHISPER_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
const HF_VAD_BASE = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main'

// The full set the mobile suite pulls on-device:
//   - ggml-tiny.bin + the Silero VAD model: functional tests (getTestPaths)
//   - the base/small q5_1/q8_0 quants: the perf sweep (mobile-perf-sweep-{cpu,gpu}.test.js),
//     which runs whenever the workflow sets enables-perf: 'true'.
// Keep in sync with getTestPaths() and CPU_SWEEP/GPU_SWEEP in those tests.
const MODELS = [
  { name: 'ggml-tiny.bin', url: `${HF_WHISPER_BASE}/ggml-tiny.bin` },
  { name: 'ggml-silero-v5.1.2.bin', url: `${HF_VAD_BASE}/ggml-silero-v5.1.2.bin` },
  { name: 'ggml-base-q5_1.bin', url: `${HF_WHISPER_BASE}/ggml-base-q5_1.bin` },
  { name: 'ggml-base-q8_0.bin', url: `${HF_WHISPER_BASE}/ggml-base-q8_0.bin` },
  { name: 'ggml-small-q5_1.bin', url: `${HF_WHISPER_BASE}/ggml-small-q5_1.bin` },
  { name: 'ggml-small-q8_0.bin', url: `${HF_WHISPER_BASE}/ggml-small-q8_0.bin` }
]

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
  console.error(
    `[prestage] staging ${MODELS.length} model(s): ${MODELS.map((m) => m.name).join(', ')}`
  )
  // generate-testspec.sh treats a lone "|" line as a YAML literal block whose
  // body lines are indented by 2 spaces.
  process.stdout.write(formatYamlBlock(buildScript(MODELS)))
}

if (require.main === module) main()

module.exports = { MODELS, buildScript, formatYamlBlock }
