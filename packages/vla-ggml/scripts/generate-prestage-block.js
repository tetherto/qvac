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

// `test` is the test-groups.json function name the composite bakes into each
// shard's wdio grep. pi05 is intentionally absent (deferred on mobile).
const MODEL_SHARDS = [
  { test: 'runAddonTest', name: 'smolvla-libero-vision-q8.gguf', urlsFile: 'smolvla-urls.json' },
  { test: 'runGrootTest', name: 'groot-q5_vf16.gguf', urlsFile: 'groot-urls.json' }
]

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
