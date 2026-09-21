'use strict'
// Emits the vla-ggml mobile workflow's `extra-pre-test-commands` value: a host
// script (run in the Device Farm pre_test phase) that downloads the running
// shard's GGUF on the host's reliable network and adb-pushes it to
// /data/local/tmp/prestaged-models, so the phone doesn't fetch the multi-GB VLA
// model from presigned S3. vla-ggml is sharded by model, and the models are too
// large to stage all on every device, so we stage ONLY the running shard's
// model: the host block reads the shard's grep from tests/wdio.config.devicefarm.js
// and picks the matching model(s) from a baked manifest (the parakeet pattern).
// pi05 is deferred on mobile (_skipMobilePi05) so it stages nothing.
//
// generate-smolvla-presigned-url.sh / generate-groot-presigned-url.sh write the
// presigned URLs to {smolvla,groot}-urls.json before this runs. Device-side
// pickup lives in test/integration/_vla-model-download.cjs.

const fs = require('fs')
const path = require('path')

const DEFAULT_ASSETS_DIR = path.resolve(__dirname, '../test/mobile/testAssets')
const IOS_BUNDLE_ID = 'io.tether.test.qvac'

// `test` is the test-groups.json function name the composite bakes into each
// shard's wdio grep. pi05 is intentionally absent (deferred on mobile).
const MODEL_SHARDS = [
  { test: 'runAddonTest', name: 'smolvla-libero-vision-q8.gguf', urlsFile: 'smolvla-urls.json' },
  { test: 'runGrootTest', name: 'groot-q5_vf16.gguf', urlsFile: 'groot-urls.json' }
]

// The static set of mobile runner names — the drift oracle. buildManifest below
// only bakes shards whose presigned URL already exists, and pi05 is deferred on
// mobile, so a grep that matches a KNOWN runner but no manifest key is a legit
// "URL not staged yet -> network fallback". A grep that matches NO known runner
// at all is a test-groups <-> model-map drift and must fail closed. Emitted as a
// single-quoted JS array literal so it stays safe inside the `node -e "…"` arg.
function knownRunnersLiteral() {
  return '[' + MODEL_SHARDS.map((s) => `'${s.test}'`).join(',') + ']'
}

// Build the { <testFn>: [{ name, url }] } manifest from the bundled *-urls.json.
// Only shards with a usable https presigned URL are included.
function buildManifest(assetsDir = DEFAULT_ASSETS_DIR) {
  const manifest = {}
  for (const { test, name, urlsFile } of MODEL_SHARDS) {
    const p = path.join(assetsDir, urlsFile)
    if (!fs.existsSync(p)) continue
    let config
    try {
      config = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch (_) {
      continue
    }
    const url = config && config.modelUrl
    if (typeof url === 'string' && url.startsWith('https://')) {
      manifest[test] = [{ name, url }]
    }
  }
  return manifest
}

// Reads the shard grep, resolves the matching model(s) from the baked manifest,
// and adb-pushes only those.
function buildAndroidScript(manifestB64) {
  return `set -e
PRESTAGE_DIR=/data/local/tmp/prestaged-models
PRESTAGE_TMP=/tmp/prestage
PRESTAGE_READY=1
if ! mkdir -p "$PRESTAGE_TMP"; then
  echo "[prestage] WARN: host temp setup failed; device will use network fallback"
  PRESTAGE_READY=0
fi
GREP=''
if [ "$PRESTAGE_READY" = "1" ]; then
  if ! echo "${manifestB64}" | base64 -d > "$PRESTAGE_TMP/model-manifest.json"; then
    echo "[prestage] WARN: manifest setup failed; device will use network fallback"
    PRESTAGE_READY=0
  fi
fi
if [ "$PRESTAGE_READY" = "1" ]; then
  GREP=$(node -e "const fs=require('fs');try{const s=fs.readFileSync('tests/wdio.config.devicefarm.js','utf8');const m=s.match(/grep:\\s*[\\"']([^\\"']*)[\\"']/);process.stdout.write(m?m[1]:'')}catch(e){process.stdout.write('')}")
  export GREP
  echo "[prestage] shard grep: '$GREP'"
  PRESTAGE_RC=0
  node -e "const fs=require('fs');const man=JSON.parse(fs.readFileSync('/tmp/prestage/model-manifest.json','utf8'));const known=${knownRunnersLiteral()};const g=(process.env.GREP||'').trim();let re=null;if(g){try{re=new RegExp(g)}catch(e){console.error('[prestage] FATAL: invalid tests grep /'+g+'/ ('+e.message+')');process.exit(3)}}else{console.error('[prestage] WARN: no shard grep resolved — staging nothing so the device downloads its own models')}if(re&&!known.filter(k=>re.test(k)).length){console.error('[prestage] FATAL: tests grep /'+g+'/ matched no known runner (test-groups <-> model-map drift)');process.exit(3)}const tests=re?Object.keys(man).filter(k=>re.test(k)):[];if(re&&!tests.length)console.error('[prestage] WARN: tests grep /'+g+'/ matched a known runner with no baked URL yet; device will use network fallback');const seen=new Set();const out=[];for(const t of tests){for(const m of (man[t]||[])){if(!seen.has(m.name)){seen.add(m.name);out.push(m.name+'\\t'+m.url)}}}fs.writeFileSync('/tmp/prestage/prestage-list.tsv',out.join('\\n')+(out.length?'\\n':''));console.error('[prestage] '+out.length+' model(s) for '+tests.length+' test(s)')" || PRESTAGE_RC=$?
  if [ "$PRESTAGE_RC" = "3" ]; then
    echo "[prestage] FATAL: shard grep matched no known runner (test-groups <-> model-map drift)"
    exit 1
  elif [ "$PRESTAGE_RC" != "0" ]; then
    echo "[prestage] WARN: shard manifest resolution failed; device will use network fallback"
    PRESTAGE_READY=0
  fi
fi
if [ "$PRESTAGE_READY" = "1" ]; then
  if ! adb shell mkdir -p "$PRESTAGE_DIR"; then
    echo "[prestage] WARN: adb setup failed; device will use network fallback"
    PRESTAGE_READY=0
  fi
fi
if [ "$PRESTAGE_READY" = "1" ]; then
  while IFS=$(printf '\\t') read -r NAME URL; do
    [ -z "$NAME" ] && continue
    echo "[prestage] staging $NAME"
    adb shell rm -f "$PRESTAGE_DIR/$NAME" || true
    if ! curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 3600 -o "$PRESTAGE_TMP/$NAME" "$URL"; then
      echo "[prestage] WARN: host download failed for $NAME; device will use network fallback"
      rm -f "$PRESTAGE_TMP/$NAME"
      continue
    fi
    if ! adb push "$PRESTAGE_TMP/$NAME" "$PRESTAGE_DIR/$NAME"; then
      echo "[prestage] WARN: adb push failed for $NAME; device will use network fallback"
      adb shell rm -f "$PRESTAGE_DIR/$NAME" || true
      rm -f "$PRESTAGE_TMP/$NAME"
      continue
    fi
    if ! adb shell test -s "$PRESTAGE_DIR/$NAME"; then
      echo "[prestage] WARN: staged $NAME is empty; device will use network fallback"
      adb shell rm -f "$PRESTAGE_DIR/$NAME" || true
      rm -f "$PRESTAGE_TMP/$NAME"
      continue
    fi
    rm -f "$PRESTAGE_TMP/$NAME"
  done < "$PRESTAGE_TMP/prestage-list.tsv"
fi
echo "[prestage] device contents:"
adb shell ls -la "$PRESTAGE_DIR" || true
echo "[prestage] done"`
}

function buildIosScript(manifestB64) {
  return `set -e
export PATH="$HOME/.local/bin:$PATH"
unset SUDO_UID SUDO_GID
BID=${IOS_BUNDLE_ID}
PRESTAGE_TMP=/tmp/prestage
PRESTAGE_READY=1
if ! (python3 -m pip install --quiet --upgrade pymobiledevice3==10.3.1 || pip3 install --quiet --upgrade pymobiledevice3==10.3.1 || python3 -m pip install --quiet --upgrade --break-system-packages pymobiledevice3==10.3.1); then
  echo "[prestage] WARN: pymobiledevice3 install failed; device will use network fallback"
  PRESTAGE_READY=0
fi
if [ "$PRESTAGE_READY" = "1" ] && ! pymobiledevice3 version >/dev/null 2>&1; then
  echo "[prestage] WARN: pymobiledevice3 not runnable; device will use network fallback"
  PRESTAGE_READY=0
fi
if ! mkdir -p "$PRESTAGE_TMP"; then
  echo "[prestage] WARN: host temp setup failed; device will use network fallback"
  PRESTAGE_READY=0
fi
GREP=''
if [ "$PRESTAGE_READY" = "1" ]; then
  if ! echo "${manifestB64}" | base64 -d > "$PRESTAGE_TMP/model-manifest.json"; then
    echo "[prestage] WARN: manifest setup failed; device will use network fallback"
    PRESTAGE_READY=0
  fi
fi
if [ "$PRESTAGE_READY" = "1" ]; then
  GREP=$(node -e "const fs=require('fs');try{const s=fs.readFileSync('tests/wdio.config.devicefarm.js','utf8');const m=s.match(/grep:\\s*[\\"']([^\\"']*)[\\"']/);process.stdout.write(m?m[1]:'')}catch(e){process.stdout.write('')}")
  export GREP
  echo "[prestage] shard grep: '$GREP'"
  PRESTAGE_RC=0
  node -e "const fs=require('fs');const man=JSON.parse(fs.readFileSync('/tmp/prestage/model-manifest.json','utf8'));const known=${knownRunnersLiteral()};const g=(process.env.GREP||'').trim();let re=null;if(g){try{re=new RegExp(g)}catch(e){console.error('[prestage] FATAL: invalid tests grep /'+g+'/ ('+e.message+')');process.exit(3)}}else{console.error('[prestage] WARN: no shard grep resolved — staging nothing so the device downloads its own models')}if(re&&!known.filter(k=>re.test(k)).length){console.error('[prestage] FATAL: tests grep /'+g+'/ matched no known runner (test-groups <-> model-map drift)');process.exit(3)}const tests=re?Object.keys(man).filter(k=>re.test(k)):[];if(re&&!tests.length)console.error('[prestage] WARN: tests grep /'+g+'/ matched a known runner with no baked URL yet; device will use network fallback');const seen=new Set();const out=[];for(const t of tests){for(const m of (man[t]||[])){if(!seen.has(m.name)){seen.add(m.name);out.push(m.name+'\\t'+m.url)}}}fs.writeFileSync('/tmp/prestage/prestage-list.tsv',out.join('\\n')+(out.length?'\\n':''));console.error('[prestage] '+out.length+' model(s) for '+tests.length+' test(s)')" || PRESTAGE_RC=$?
  if [ "$PRESTAGE_RC" = "3" ]; then
    echo "[prestage] FATAL: shard grep matched no known runner (test-groups <-> model-map drift)"
    exit 1
  elif [ "$PRESTAGE_RC" != "0" ]; then
    echo "[prestage] WARN: shard manifest resolution failed; device will use network fallback"
    PRESTAGE_READY=0
  fi
fi
if [ "$PRESTAGE_READY" = "1" ]; then
  while IFS=$(printf '\\t') read -r NAME URL; do
    [ -z "$NAME" ] && continue
    echo "[prestage] staging $NAME"
    if ! curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 3600 -o "$PRESTAGE_TMP/$NAME" "$URL"; then
      echo "[prestage] WARN: host download failed for $NAME; device will use network fallback"
      rm -f "$PRESTAGE_TMP/$NAME"
      continue
    fi
    if PUSH_OUT=$(pymobiledevice3 apps push "$BID" "$PRESTAGE_TMP/$NAME" "Documents/$NAME" 2>&1); then PUSH_RC=0; else PUSH_RC=$?; fi
    printf '%s\\n' "$PUSH_OUT"
    if [ "$PUSH_RC" -ne 0 ] || printf '%s' "$PUSH_OUT" | grep -qiE "traceback|afcexception|not found during afc operation|failed to perform afc operation|failed with status|perm_denied|object_not_found|not permitted"; then
      echo "[prestage] WARN: push of $NAME failed (rc=$PUSH_RC); device will use network fallback"
      rm -f "$PRESTAGE_TMP/$NAME"
      continue
    fi
    echo "[prestage] pushed $NAME -> Documents/$NAME"
    rm -f "$PRESTAGE_TMP/$NAME"
  done < "$PRESTAGE_TMP/prestage-list.tsv"
fi
echo "[prestage] done"`
}

function buildScript(manifestB64, platform = 'android') {
  const p = String(platform).toLowerCase()
  if (p === 'ios') return buildIosScript(manifestB64)
  if (p === 'android') return buildAndroidScript(manifestB64)
  throw new Error(`[prestage] unknown platform "${platform}" (expected 'android' or 'ios')`)
}

function formatYamlBlock(script) {
  const body = script
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  return '|\n' + body + '\n'
}

function main() {
  const platform = process.argv[2] || 'android'
  const manifest = buildManifest()
  const testCount = Object.keys(manifest).length
  if (testCount === 0) {
    console.error('[prestage] no vla *-urls.json found — skipping pre-stage')
    return
  }
  console.error(
    `[prestage] baked manifest for ${testCount} shard(s): ${Object.keys(manifest).join(', ')}`
  )
  const manifestB64 = Buffer.from(JSON.stringify(manifest)).toString('base64')
  process.stdout.write(formatYamlBlock(buildScript(manifestB64, platform)))
}

if (require.main === module) main()

module.exports = { MODEL_SHARDS, buildManifest, buildScript, formatYamlBlock, IOS_BUNDLE_ID }
