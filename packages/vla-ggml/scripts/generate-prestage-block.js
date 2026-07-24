'use strict'
// Emit the YAML value for the vla-ggml mobile workflow's
// `extra-pre-test-commands` input: a host script (run in the Device Farm
// pre_test phase, where the network is reliable) that pre-stages the running
// shard's GGUF onto the device at /data/local/tmp/prestaged-models, so the phone
// never downloads the multi-GB VLA model from presigned S3 during the test phase
// (QVAC-21799) — the documented source of the Device Farm mobile-network
// truncation/timeout flakiness on these large models.
//
// vla-ggml runs SHARDED by model (test/mobile/test-groups.json):
//   smolvla -> runAddonTest -> smolvla-libero-vision-q8.gguf (~1.9GB)
//   groot   -> runGrootTest -> groot-q5_vf16.gguf (~2.7GB)
//   pi05    -> runPi05Test  -> deferred on mobile (_skipMobilePi05), no model
// The models are large, so we stage ONLY the running shard's model. Mirroring the
// transcription-parakeet generator, the emitted host block reads that shard's
// grep from tests/wdio.config.devicefarm.js (generated per-group by the composite)
// and stages just the matching model(s) from a baked manifest. pi05 shards match
// nothing and stage nothing.
//
// The presigned URLs are produced on the runner by
// scripts/generate-smolvla-presigned-url.sh / generate-groot-presigned-url.sh and
// written into test/mobile/testAssets/{smolvla,groot}-urls.json BEFORE this script
// runs, so we read them back and bake them into the manifest. Device-side pickup
// lives in test/integration/_vla-model-download.cjs (copyPrestagedModel), called
// from _ensureMobileModel in addon.test.js / groot.test.js.

const fs = require('fs')
const path = require('path')

const DEFAULT_ASSETS_DIR = path.resolve(__dirname, '../test/mobile/testAssets')

// Per-shard model set. `test` is the test-groups.json function name (which the
// composite bakes into each shard's wdio grep); pi05 is intentionally absent.
const MODEL_SHARDS = [
  { test: 'runAddonTest', name: 'smolvla-libero-vision-q8.gguf', urlsFile: 'smolvla-urls.json' },
  { test: 'runGrootTest', name: 'groot-q5_vf16.gguf', urlsFile: 'groot-urls.json' }
]

// Build the { <testFn>: [{ name, url }] } manifest from the bundled *-urls.json.
// Only shards with a usable https presigned URL are included; a missing config
// (e.g. GR00T presign hiccup) simply drops that shard from the manifest.
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

// Host script (POSIX sh; adb + curl + node available in the pre_test phase). It
// reads the shard grep, resolves the matching model(s) from the baked manifest,
// and adb-pushes only those. Byte-for-byte the transcription-parakeet approach.
function buildScript(manifestB64) {
  return `set -e
PRESTAGE_DIR=/data/local/tmp/prestaged-models
echo "${manifestB64}" | base64 -d > /tmp/model-manifest.json
GREP=$(node -e "const fs=require('fs');try{const s=fs.readFileSync('tests/wdio.config.devicefarm.js','utf8');const m=s.match(/grep:\\s*'([^']*)'/);process.stdout.write(m?m[1]:'')}catch(e){process.stdout.write('')}")
export GREP
echo "[prestage] shard grep: '$GREP'"
node -e "const fs=require('fs');const man=JSON.parse(fs.readFileSync('/tmp/model-manifest.json','utf8'));const g=process.env.GREP||'';const tests=g?g.split('|').map(s=>s.trim()).filter(Boolean):Object.keys(man);const seen=new Set();const out=[];for(const t of tests){for(const m of (man[t]||[])){if(!seen.has(m.name)){seen.add(m.name);out.push(m.name+'\\t'+m.url)}}}fs.writeFileSync('/tmp/prestage-list.tsv',out.join('\\n')+(out.length?'\\n':''));console.error('[prestage] '+out.length+' model(s) for '+tests.length+' test(s)')"
adb shell mkdir -p "$PRESTAGE_DIR"
mkdir -p /tmp/prestage
while IFS=$(printf '\\t') read -r NAME URL; do
  [ -z "$NAME" ] && continue
  echo "[prestage] staging $NAME"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 3600 -o "/tmp/prestage/$NAME" "$URL"
  adb push "/tmp/prestage/$NAME" "$PRESTAGE_DIR/$NAME"
  adb shell test -s "$PRESTAGE_DIR/$NAME" || { echo "[prestage] FATAL: $NAME not present on device after push"; exit 1; }
  rm -f "/tmp/prestage/$NAME"
done < /tmp/prestage-list.tsv
echo "[prestage] device contents:"
adb shell ls -la "$PRESTAGE_DIR" || true
echo "[prestage] done"`
}

function main() {
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
  const body = buildScript(manifestB64)
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  process.stdout.write('|\n' + body + '\n')
}

if (require.main === module) main()

module.exports = { MODEL_SHARDS, buildManifest, buildScript }
