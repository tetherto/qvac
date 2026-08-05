'use strict'

const fs = require('fs')
const path = require('path')

const manifestPath = path.resolve(__dirname, '../test/mobile/testAssets/model-manifest.json')
const IOS_BUNDLE_ID = 'io.tether.test.qvac'

// Whisper models are public HuggingFace downloads, so they are prestaged from a
// fixed list here rather than through the presigned manifest that drives
// parakeet. Device-side pickup for these lives in test/integration/helpers.js
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

// Whisper staging degrades gracefully: unlike parakeet's 600 MB-class GGUFs
// (fail-hard above), whisper's tiny/VAD/quant models are small enough to fetch
// on-device, so a host-side miss just warns and lets helpers.ensureWhisperModel
// download from HuggingFace. A .size sidecar is pushed next to each model so the
// device-side copy can reject a truncated push.
function buildAndroidWhisperStageBlock(models) {
  const stageCalls = models.map((m) => `stage "${m.name}" "${m.url}"`).join('\n')
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
}
${stageCalls}`
}

function buildIosWhisperStageBlock(models) {
  const stageCalls = models.map((m) => `stage "${m.name}" "${m.url}"`).join('\n')
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
  if [ "$PUSH_RC" -ne 0 ] || printf '%s' "$PUSH_OUT" | grep -qiE "traceback|afcexception|failed with status|perm_denied|object_not_found|not permitted"; then
    echo "[prestage] WARN: push of $NAME failed (rc=$PUSH_RC); device will use network fallback"
    rm -f "/tmp/prestage/$NAME" "/tmp/prestage/$NAME.size"
    return 0
  fi
  if PUSH_OUT=$(pymobiledevice3 apps push "$BID" "/tmp/prestage/$NAME.size" "Documents/$NAME.size" 2>&1); then PUSH_RC=0; else PUSH_RC=$?; fi
  printf '%s\\n' "$PUSH_OUT"
  if [ "$PUSH_RC" -ne 0 ] || printf '%s' "$PUSH_OUT" | grep -qiE "traceback|afcexception|failed with status|perm_denied|object_not_found|not permitted"; then
    echo "[prestage] WARN: size metadata push failed for $NAME (rc=$PUSH_RC); device will use network fallback"
    rm -f "/tmp/prestage/$NAME" "/tmp/prestage/$NAME.size"
    return 0
  fi
  echo "[prestage] pushed $NAME -> Documents/$NAME"
  rm -f "/tmp/prestage/$NAME" "/tmp/prestage/$NAME.size"
}
${stageCalls}`
}

function buildWhisperStageBlock(models, platform = 'android') {
  const p = String(platform).toLowerCase()
  if (p === 'ios') return buildIosWhisperStageBlock(models)
  if (p === 'android') return buildAndroidWhisperStageBlock(models)
  throw new Error(`[prestage] unknown platform "${platform}" (expected 'android' or 'ios')`)
}

// Parakeet block: presigned-S3 GGUFs resolved from the manifest by the deployed
// wdio config's grep, staged fail-hard (a missing 600 MB-class model on-device
// would blow the mocha budget). Whisper block appended after, staged gracefully.
function buildAndroidScript(manifestB64) {
  return `set -e
PRESTAGE_DIR=/data/local/tmp/prestaged-models
adb shell mkdir -p "$PRESTAGE_DIR"
mkdir -p /tmp/prestage
echo "${manifestB64}" | base64 -d > /tmp/model-manifest.json
GREP=$(node -e "const fs=require('fs');try{const s=fs.readFileSync('tests/wdio.config.devicefarm.js','utf8');const m=s.match(/grep:\\s*'([^']*)'/);process.stdout.write(m?m[1]:'')}catch(e){process.stdout.write('')}")
export GREP
echo "[prestage] shard grep: '$GREP'"
node -e "const fs=require('fs');const man=JSON.parse(fs.readFileSync('/tmp/model-manifest.json','utf8'));const g=process.env.GREP||'';const tests=g?g.split('|').map(s=>s.trim()).filter(Boolean):Object.keys(man);const seen=new Set();const out=[];for(const t of tests){for(const m of (man[t]||[])){if(!seen.has(m.name)){seen.add(m.name);out.push(m.name+'\\t'+m.url)}}}fs.writeFileSync('/tmp/prestage-list.tsv',out.join('\\n')+(out.length?'\\n':''));console.error('[prestage] '+out.length+' model(s) for '+tests.length+' test(s)')"
while IFS=$(printf '\\t') read -r NAME URL; do
  [ -z "$NAME" ] && continue
  echo "[prestage] staging $NAME"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$NAME" "$URL"
  adb push "/tmp/prestage/$NAME" "$PRESTAGE_DIR/$NAME"
  adb shell test -s "$PRESTAGE_DIR/$NAME" || { echo "[prestage] FATAL: $NAME not present on device after push"; exit 1; }
  rm -f "/tmp/prestage/$NAME"
done < /tmp/prestage-list.tsv
${buildWhisperStageBlock(WHISPER_MODELS, 'android')}
echo "[prestage] device contents:"
adb shell ls -la "$PRESTAGE_DIR" || true
echo "[prestage] done"`
}

function buildIosScript(manifestB64) {
  return `set -e
export PATH="$HOME/.local/bin:$PATH"
unset SUDO_UID SUDO_GID
BID=${IOS_BUNDLE_ID}
PRESTAGE_READY=1
mkdir -p /tmp/prestage
echo "${manifestB64}" | base64 -d > /tmp/model-manifest.json
GREP=$(node -e "const fs=require('fs');try{const s=fs.readFileSync('tests/wdio.config.devicefarm.js','utf8');const m=s.match(/grep:\\s*'([^']*)'/);process.stdout.write(m?m[1]:'')}catch(e){process.stdout.write('')}")
export GREP
echo "[prestage] shard grep: '$GREP'"
node -e "const fs=require('fs');const man=JSON.parse(fs.readFileSync('/tmp/model-manifest.json','utf8'));const g=process.env.GREP||'';const tests=g?g.split('|').map(s=>s.trim()).filter(Boolean):Object.keys(man);const seen=new Set();const out=[];for(const t of tests){for(const m of (man[t]||[])){if(!seen.has(m.name)){seen.add(m.name);out.push(m.name+'\\t'+m.url)}}}fs.writeFileSync('/tmp/prestage-list.tsv',out.join('\\n')+(out.length?'\\n':''));console.error('[prestage] '+out.length+' model(s) for '+tests.length+' test(s)')"
if ! (python3 -m pip install --quiet --upgrade pymobiledevice3 || pip3 install --quiet --upgrade pymobiledevice3 || python3 -m pip install --quiet --upgrade --break-system-packages pymobiledevice3); then
  echo "[prestage] WARN: pymobiledevice3 install failed; whisper will use network fallback"
  PRESTAGE_READY=0
fi
if [ "$PRESTAGE_READY" = "1" ] && ! pymobiledevice3 version >/dev/null 2>&1; then
  echo "[prestage] WARN: pymobiledevice3 not runnable; whisper will use network fallback"
  PRESTAGE_READY=0
fi
if [ "$PRESTAGE_READY" != "1" ] && [ -s /tmp/prestage-list.tsv ]; then
  echo "[prestage] FATAL: pymobiledevice3 unavailable for parakeet pre-stage"; exit 1
fi
if [ "$PRESTAGE_READY" = "1" ]; then
  while IFS=$(printf '\\t') read -r NAME URL; do
    [ -z "$NAME" ] && continue
    echo "[prestage] staging $NAME"
    curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$NAME" "$URL"
    if PUSH_OUT=$(pymobiledevice3 apps push "$BID" "/tmp/prestage/$NAME" "Documents/$NAME" 2>&1); then PUSH_RC=0; else PUSH_RC=$?; fi
    printf '%s\\n' "$PUSH_OUT"
    if [ "$PUSH_RC" -ne 0 ] || printf '%s' "$PUSH_OUT" | grep -qiE "traceback|afcexception|failed with status|perm_denied|object_not_found|not permitted"; then
      echo "[prestage] FATAL: push of $NAME failed (rc=$PUSH_RC; see AFC error above)"; exit 1
    fi
    echo "[prestage] pushed $NAME -> Documents/$NAME"
    rm -f "/tmp/prestage/$NAME"
  done < /tmp/prestage-list.tsv
fi
${buildWhisperStageBlock(WHISPER_MODELS, 'ios')}
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

module.exports = { WHISPER_MODELS, buildWhisperStageBlock, buildScript, IOS_BUNDLE_ID }
