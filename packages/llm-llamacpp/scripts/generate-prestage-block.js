'use strict'
// Emit the YAML value for the mobile workflow's `extra-pre-test-commands`
// input: a self-contained host script (run in the Device Farm pre_test phase,
// where the network is reliable) that pre-stages exactly the models THIS shard
// needs onto the device, so the phone never downloads from huggingface.co. The
// shard is identified at runtime from the grep pattern in the decoded wdio
// config. Shard membership comes from the mobile manifest, while URLs come from
// the pinned integration manifest. The resolved manifest is base64-embedded
// here so it is available on the host without shipping it in the test package.
//
// Two device-staging backends, selected by the CLI arg ('android' | 'ios'):
//   Android: `adb push` into /data/local/tmp/prestaged-models (adb-writable +
//            app-readable; the app's own scoped dirs reject adb on API 30+).
//   iOS:     `pymobiledevice3 apps push <bundle> <file> Documents/<name>` into
//            the app's data container (works because the test app is dev-signed
//            with get-task-allow=true). On-device that dir is exposed as
//            global.testDir. Proven feasible on Device Farm (usbmux/house_arrest
//            reachable; app installed by pre_test; byte-exact round-trip).
const fs = require('fs')
const path = require('path')
const {
  matrix,
  modelFileName,
  runFunctionName
} = require('../test/integration/_benchmark-matrix.js')

const mobileManifestPath = path.resolve(__dirname, '../test/mobile/model-manifest.json')
const integrationManifestPath = path.resolve(__dirname, '../test/integration/models.manifest.json')

const IOS_BUNDLE_ID = 'io.tether.test.qvac'

function benchmarkModelsByTest() {
  return Object.fromEntries(
    matrix().map((cell) => [
      runFunctionName(cell),
      [{ name: modelFileName(cell.size, cell.quant) }]
    ])
  )
}

function resolvePinnedManifest(mobileManifest, integrationManifest) {
  if (!integrationManifest || !integrationManifest.models) {
    throw new Error('[prestage] integration model manifest has no models')
  }

  // Benchmark shard sources construct model names dynamically, so the static
  // mobile-manifest extractor cannot see them. Derive all 70 grep-name mappings
  // from the same matrix that generates the shard files and workflow groups.
  const modelsByTest = { ...mobileManifest, ...benchmarkModelsByTest() }

  return Object.fromEntries(
    Object.entries(modelsByTest).map(([testName, models]) => [
      testName,
      models.map(({ name }) => {
        const entry = integrationManifest.models[name]
        const url = entry && Array.isArray(entry.urls) ? entry.urls[0] : null
        if (
          typeof url !== 'string' ||
          !/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//i.test(url)
        ) {
          throw new Error(`[prestage] ${name} has no usable pinned manifest URL`)
        }
        return { name, url }
      })
    ])
  )
}

// Shared host-side prelude: decode the embedded manifest, read the shard's grep
// from the decoded wdio config, and expand it into a /tmp/prestage-list.tsv of
// "<name>\t<url>" rows (deduped) for exactly the tests this shard runs. Emitted
// identically for both backends so shard resolution stays single-sourced.
function commonPrelude(manifestB64) {
  return `echo "${manifestB64}" | base64 -d > /tmp/model-manifest.json
GREP=$(node -e "const fs=require('fs');try{const s=fs.readFileSync('tests/wdio.config.devicefarm.js','utf8');const m=s.match(/grep:\\s*'([^']*)'/);process.stdout.write(m?m[1]:'')}catch(e){process.stdout.write('')}")
export GREP
echo "[prestage] shard grep: '$GREP'"
node -e "const fs=require('fs');const man=JSON.parse(fs.readFileSync('/tmp/model-manifest.json','utf8'));const g=process.env.GREP||'';const tests=g?g.split('|').map(s=>s.trim()).filter(Boolean):Object.keys(man);const missing=tests.filter(t=>t.startsWith('runBenchmarkPerf')&&!man[t]);if(missing.length)throw new Error('[prestage] missing benchmark mapping(s): '+missing.join(', '));const seen=new Set();const out=[];for(const t of tests){for(const m of (man[t]||[])){if(!seen.has(m.name)){seen.add(m.name);out.push(m.name+'\\t'+m.url)}}}fs.writeFileSync('/tmp/prestage-list.tsv',out.join('\\n')+(out.length?'\\n':''));console.error('[prestage] '+out.length+' model(s) for '+tests.length+' test(s)')"
mkdir -p /tmp/prestage`
}

function buildAndroidScript(manifestB64) {
  // Host script. Kept POSIX-sh friendly; node + adb + curl are all available
  // in the Device Farm pre_test phase.
  return `set -e
PRESTAGE_DIR=/data/local/tmp/prestaged-models
${commonPrelude(manifestB64)}
adb shell mkdir -p "$PRESTAGE_DIR"
while IFS=$(printf '\\t') read -r NAME URL; do
  [ -z "$NAME" ] && continue
  echo "[prestage] staging $NAME"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$NAME" "$URL"
  adb push "/tmp/prestage/$NAME" "$PRESTAGE_DIR/$NAME"
  adb shell test -s "$PRESTAGE_DIR/$NAME" || { echo "[prestage] FATAL: $NAME not present on device after push"; exit 1; }
  rm -f "/tmp/prestage/$NAME"
done < /tmp/prestage-list.tsv
echo "[prestage] device contents:"
adb shell ls -la "$PRESTAGE_DIR" || true
echo "[prestage] done"`
}

function buildIosScript(manifestB64) {
  // Host script for the Device Farm iOS host (macOS). node + curl + python3/pip
  // are available. pymobiledevice3 is installed on demand and talks to the
  // device over usbmux/house_arrest.
  //
  // Two host-environment quirks, both proven on Device Farm iOS:
  //   1. The pre_test phase runs under sudo, so SUDO_UID/SUDO_GID are set and
  //      pymobiledevice3 aborts trying to chown ~/.pymobiledevice3 (EPERM).
  //      Unsetting them makes it skip the chown.
  //   2. A failed `apps push` must fail the prestage. On the pinned
  //      pymobiledevice3 (==10.3.1) an AFC error — including the
  //      AfcFileNotFoundError raised when the remote parent is missing — is NOT
  //      swallowed: it propagates as a traceback and a non-zero exit, so the
  //      guard below fails closed on both signals. The AFC failure-token regex
  //      is a version-proof backstop for older CLIs (e.g. the monolithic
  //      __main__.py) that log the AFC error but still exit 0; it includes the
  //      two literal handler prefixes ("... not found during afc operation",
  //      "failed to perform afc operation"). We deliberately do NOT match a bare
  //      "error" (false-positives on benign lines). Together this gives iOS the
  //      same fail-closed guarantee Android gets from `adb shell test -s`.
  return `set -e
export PATH="$HOME/.local/bin:$PATH"
unset SUDO_UID SUDO_GID
BID=${IOS_BUNDLE_ID}
echo "[prestage] installing pymobiledevice3..."
python3 -m pip install --quiet --upgrade pymobiledevice3==10.3.1 || pip3 install --quiet --upgrade pymobiledevice3==10.3.1 || python3 -m pip install --quiet --upgrade --break-system-packages pymobiledevice3==10.3.1 || { echo "[prestage] FATAL: pymobiledevice3 install failed"; exit 1; }
pymobiledevice3 version >/dev/null 2>&1 || { echo "[prestage] FATAL: pymobiledevice3 not runnable"; exit 1; }
${commonPrelude(manifestB64)}
while IFS=$(printf '\\t') read -r NAME URL; do
  [ -z "$NAME" ] && continue
  echo "[prestage] staging $NAME"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$NAME" "$URL"
  if PUSH_OUT=$(pymobiledevice3 apps push "$BID" "/tmp/prestage/$NAME" "Documents/$NAME" 2>&1); then PUSH_RC=0; else PUSH_RC=$?; fi
  printf '%s\\n' "$PUSH_OUT"
  if [ "$PUSH_RC" -ne 0 ] || printf '%s' "$PUSH_OUT" | grep -qiE "traceback|afcexception|not found during afc operation|failed to perform afc operation|failed with status|perm_denied|object_not_found|not permitted"; then
    echo "[prestage] FATAL: push of $NAME failed (rc=$PUSH_RC; see AFC error above)"; exit 1
  fi
  echo "[prestage] pushed $NAME -> Documents/$NAME"
  rm -f "/tmp/prestage/$NAME"
done < /tmp/prestage-list.tsv
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
  const mobileManifest = JSON.parse(fs.readFileSync(mobileManifestPath, 'utf8'))
  const integrationManifest = JSON.parse(fs.readFileSync(integrationManifestPath, 'utf8'))
  const manifest = resolvePinnedManifest(mobileManifest, integrationManifest)
  const manifestB64 = Buffer.from(JSON.stringify(manifest)).toString('base64')

  // emit_extra_commands in generate-testspec.sh treats a lone "|" line as the
  // start of a YAML literal block whose body lines are indented by 2 spaces.
  const body = buildScript(manifestB64, platform)
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  process.stdout.write('|\n' + body + '\n')
}

if (require.main === module) main()

module.exports = { benchmarkModelsByTest, resolvePinnedManifest, buildScript, IOS_BUNDLE_ID }
