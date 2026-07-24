'use strict'
// Emit the YAML value for the whisper mobile workflow's `extra-pre-test-commands`
// input: a host script (run in the Device Farm pre_test phase, where the network
// is reliable) that pre-stages the whisper mobile models onto the device at
// /data/local/tmp/prestaged-models, so the phone never downloads from
// huggingface.co (QVAC-21799). transcription-whispercpp runs single-pool (all
// tests on one device), so there is no per-shard selection — every model the
// mobile suite loads is staged. The device-side pickup lives in
// test/integration/helpers.js (prestagedModelPath / copyPrestagedModel).
//
// The model names + base URLs mirror the HF_WHISPER_BASE / HF_VAD_BASE constants
// and getTestPaths() in test/integration/helpers.js. Keep this list in sync if
// the mobile suite starts loading additional whisper/VAD models.
//
// Run `node scripts/generate-prestage-block.js` and paste the output under
// `extra-pre-test-commands:` (indented), or wire it via a workflow step (see
// integration-mobile-test-transcription-whispercpp.yml).

const HF_WHISPER_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
const HF_VAD_BASE = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main'

// The mobile suite loads exactly these two models (see getTestPaths() in
// test/integration/helpers.js): the tiny whisper model and the Silero VAD model.
const MODELS = [
  { name: 'ggml-tiny.bin', url: `${HF_WHISPER_BASE}/ggml-tiny.bin` },
  { name: 'ggml-silero-v5.1.2.bin', url: `${HF_VAD_BASE}/ggml-silero-v5.1.2.bin` }
]

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
  console.error(
    `[prestage] staging ${MODELS.length} model(s): ${MODELS.map((m) => m.name).join(', ')}`
  )
  // emit_extra_commands in generate-testspec.sh treats a lone "|" line as the
  // start of a YAML literal block whose body lines are indented by 2 spaces.
  const body = buildScript(MODELS)
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  process.stdout.write('|\n' + body + '\n')
}

if (require.main === module) main()

module.exports = { MODELS, buildScript }
