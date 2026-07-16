'use strict'
// Emit the YAML value for the mobile workflow's `extra-pre-test-commands`
// input: a self-contained host script (run in the Device Farm pre_test phase,
// where the network is reliable) that pre-stages exactly the models THIS shard
// needs onto the device at /data/local/tmp/prestaged-models, so the phone never
// downloads from huggingface.co. The shard is identified at runtime from the
// grep pattern in the decoded wdio config. Shard membership comes from the
// mobile manifest, while URLs come from the pinned integration manifest. The
// resolved manifest is base64-embedded here so it is available on the host
// without shipping it in the test package.
const fs = require('fs')
const path = require('path')
const {
  matrix,
  modelFileName,
  runFunctionName
} = require('../test/integration/_benchmark-matrix.js')

const mobileManifestPath = path.resolve(__dirname, '../test/mobile/model-manifest.json')
const integrationManifestPath = path.resolve(__dirname, '../test/integration/models.manifest.json')

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

function buildScript(manifestB64) {
  // Host script. Kept POSIX-sh friendly; node + adb + curl are all available
  // in the Device Farm pre_test phase.
  return `set -e
PRESTAGE_DIR=/data/local/tmp/prestaged-models
echo "${manifestB64}" | base64 -d > /tmp/model-manifest.json
GREP=$(node -e "const fs=require('fs');try{const s=fs.readFileSync('tests/wdio.config.devicefarm.js','utf8');const m=s.match(/grep:\\s*'([^']*)'/);process.stdout.write(m?m[1]:'')}catch(e){process.stdout.write('')}")
export GREP
echo "[prestage] shard grep: '$GREP'"
node -e "const fs=require('fs');const man=JSON.parse(fs.readFileSync('/tmp/model-manifest.json','utf8'));const g=process.env.GREP||'';const tests=g?g.split('|').map(s=>s.trim()).filter(Boolean):Object.keys(man);const missing=tests.filter(t=>t.startsWith('runBenchmarkPerf')&&!man[t]);if(missing.length)throw new Error('[prestage] missing benchmark mapping(s): '+missing.join(', '));const seen=new Set();const out=[];for(const t of tests){for(const m of (man[t]||[])){if(!seen.has(m.name)){seen.add(m.name);out.push(m.name+'\\t'+m.url)}}}fs.writeFileSync('/tmp/prestage-list.tsv',out.join('\\n')+(out.length?'\\n':''));console.error('[prestage] '+out.length+' model(s) for '+tests.length+' test(s)')"
adb shell mkdir -p "$PRESTAGE_DIR"
mkdir -p /tmp/prestage
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

function main() {
  const mobileManifest = JSON.parse(fs.readFileSync(mobileManifestPath, 'utf8'))
  const integrationManifest = JSON.parse(fs.readFileSync(integrationManifestPath, 'utf8'))
  const manifest = resolvePinnedManifest(mobileManifest, integrationManifest)
  const manifestB64 = Buffer.from(JSON.stringify(manifest)).toString('base64')

  // emit_extra_commands in generate-testspec.sh treats a lone "|" line as the
  // start of a YAML literal block whose body lines are indented by 2 spaces.
  const body = buildScript(manifestB64)
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  process.stdout.write('|\n' + body + '\n')
}

if (require.main === module) main()

module.exports = { benchmarkModelsByTest, resolvePinnedManifest, buildScript }
