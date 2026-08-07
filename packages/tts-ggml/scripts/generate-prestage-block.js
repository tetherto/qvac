'use strict'

const fs = require('fs')
const path = require('path')

const MANIFEST_PATH = path.resolve(__dirname, '../test/mobile/testAssets/model-manifest.json')
const PRESTAGE_DIR = '/data/local/tmp/qvac-tts-ggml/models'
const ALLOWED_VARIANTS = ['q4', 'q8']
const FUNCTIONAL_MODE_ENV = 'TTS_GGML_MOBILE_FUNCTIONAL_MULTI_SPEC'
const FUNCTIONAL_MODEL_TARGETS = {
  chatterbox: ['chatterbox-t3-turbo.gguf', 'chatterbox-s3gen.gguf'],
  chatterboxMtl: ['chatterbox-t3-mtl.gguf', 'chatterbox-s3gen-mtl.gguf'],
  supertonic: ['supertonic.gguf'],
  supertonicMtl: ['supertonic2.gguf'],
  supertonic3: [
    'supertonic3-f16.gguf',
    'supertonic3-f32.gguf',
    'supertonic3-q8_0.gguf',
    'supertonic3-q4_0.gguf'
  ],
  lavasrEnhancer: ['lavasr/lavasr-enhancer.gguf'],
  lavasrDenoiser: ['lavasr/lavasr-denoiser.gguf'],
  cosyvoice3: [
    'cosyvoice3/cosyvoice3-llm-q8_0.gguf',
    'cosyvoice3/cosyvoice3-flow-f32.gguf',
    'cosyvoice3/cosyvoice3-hift-f32.gguf',
    'cosyvoice3/voice.gguf',
    'cosyvoice3/vocab.json',
    'cosyvoice3/merges.txt'
  ]
}

// LavaSR axes map an on row (enhancer|denoiser === 'lavasr') to the manifest
// `lavasr` entry whose targetName carries that kind, so only the requested GGUF
// is pushed.
const LAVASR_AXES = [
  { flag: 'enhancer', kind: 'enhancer' },
  { flag: 'denoiser', kind: 'denoiser' }
]

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      'Missing test/mobile/testAssets/model-manifest.json. Run scripts/generate-mobile-model-manifest.js first.'
    )
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

function resolveVariant(rawVariant) {
  const variant = (rawVariant || 'q4').toLowerCase()
  if (!ALLOWED_VARIANTS.includes(variant)) {
    throw new Error(
      `Unsupported variant "${variant}". Expected one of: ${ALLOWED_VARIANTS.join(', ')}`
    )
  }
  return variant
}

function engineEntries(manifest, variant) {
  const entries = Array.isArray(manifest[variant]) ? manifest[variant] : []
  if (entries.length === 0) {
    throw new Error(`No manifest entries found for variant "${variant}"`)
  }
  return entries
}

// CosyVoice3 is a directory-consuming engine with a quant-fixed model set (LLM
// q8_0 + flow/hift f32 + tokenizer + voice), so its prestage list is the whole
// `cosyvoice` manifest group regardless of the row's variant — unlike the q4/q8
// single-GGUF engines, `variant` doesn't select a file here. The targetNames
// already carry the `cosyvoice3/` subdir the on-device resolver scans.
function cosyvoiceEntries(manifest) {
  const entries = Array.isArray(manifest.cosyvoice) ? manifest.cosyvoice : []
  if (entries.length === 0) {
    throw new Error('No manifest entries found for engine "cosyvoice"')
  }
  return entries
}

// Only the LavaSR GGUFs whose axis the row turned on. An engine-only row wants
// nothing here, so its prestage list stays byte-for-byte what it was pre-LavaSR.
function requestedLavasrKinds(axes) {
  return LAVASR_AXES.filter((axis) => axes[axis.flag] === 'lavasr').map((axis) => axis.kind)
}

function lavasrEntries(manifest, axes) {
  const available = Array.isArray(manifest.lavasr) ? manifest.lavasr : []
  const kinds = requestedLavasrKinds(axes)
  return available.filter((entry) => kinds.some((kind) => entry.targetName.includes(kind)))
}

function qualityEntries(manifest, enabled) {
  return enabled === true && Array.isArray(manifest.quality) ? manifest.quality : []
}

// A cosyvoice row pushes the fixed cosyvoice group (ignoring variant); every
// other engine keeps the exact q4/q8-by-variant selection it had before, so its
// prestage list stays byte-for-byte unchanged.
function selectEntries(manifest, options) {
  const engine =
    options.engine === 'cosyvoice'
      ? cosyvoiceEntries(manifest)
      : engineEntries(manifest, options.variant)
  return engine
    .concat(lavasrEntries(manifest, options))
    .concat(qualityEntries(manifest, options.quality))
}

function entriesByTarget(entries, targetNames) {
  const targets = new Set(targetNames)
  return entries.filter((entry) => targets.has(entry.targetName))
}

function requiredEntriesByTarget(entries, targetNames, label) {
  const selected = entriesByTarget(entries, targetNames)
  const selectedTargets = new Set(selected.map((entry) => entry.targetName))
  const missing = targetNames.filter((targetName) => !selectedTargets.has(targetName))
  if (missing.length > 0) {
    throw new Error(`Missing ${label} manifest target(s): ${missing.join(', ')}`)
  }
  return selected
}

function combineTargets(...targetGroups) {
  return targetGroups.flat()
}

function functionalModelsByTest(manifest) {
  const q4 = engineEntries(manifest, 'q4')
  const functional = Array.isArray(manifest.functional) ? manifest.functional : []
  const lavasr = Array.isArray(manifest.lavasr) ? manifest.lavasr : []
  const cosyvoice = Array.isArray(manifest.cosyvoice) ? manifest.cosyvoice : []
  const chatterbox = requiredEntriesByTarget(q4, FUNCTIONAL_MODEL_TARGETS.chatterbox, 'Chatterbox')
  const chatterboxMtl = requiredEntriesByTarget(
    q4,
    FUNCTIONAL_MODEL_TARGETS.chatterboxMtl,
    'Chatterbox MTL'
  )
  const supertonic = requiredEntriesByTarget(q4, FUNCTIONAL_MODEL_TARGETS.supertonic, 'Supertonic')
  const supertonicMtl = requiredEntriesByTarget(
    q4,
    FUNCTIONAL_MODEL_TARGETS.supertonicMtl,
    'Supertonic MTL'
  )
  const supertonic3 = requiredEntriesByTarget(
    functional,
    FUNCTIONAL_MODEL_TARGETS.supertonic3,
    'Supertonic 3'
  )
  const lavasrEnhancer = requiredEntriesByTarget(
    lavasr,
    FUNCTIONAL_MODEL_TARGETS.lavasrEnhancer,
    'LavaSR'
  )
  const lavasrDenoiser = requiredEntriesByTarget(
    lavasr,
    FUNCTIONAL_MODEL_TARGETS.lavasrDenoiser,
    'LavaSR denoiser'
  )
  const cosyvoice3 = requiredEntriesByTarget(
    cosyvoice,
    FUNCTIONAL_MODEL_TARGETS.cosyvoice3,
    'CosyVoice3'
  )

  return {
    runAddonTest: chatterbox,
    runChatterboxKvCacheGpuTest: combineTargets(chatterbox, chatterboxMtl),
    runChatterboxMtlTest: chatterboxMtl,
    runChatterboxSpeedTest: chatterbox,
    runCosyvoice3LavasrTest: combineTargets(cosyvoice3, lavasrEnhancer, lavasrDenoiser),
    runCosyvoice3Test: cosyvoice3,
    runGpuSmokeTest: q4,
    runLavasrEnhancerTest: combineTargets(chatterbox, supertonic, lavasrEnhancer),
    runMultipleRunsTest: combineTargets(chatterbox, supertonic),
    runOutputSampleRateTest: supertonic,
    runParlerTest: [],
    runSupertonicMtlTest: supertonicMtl,
    runSupertonicTest: supertonic,
    runSupertonic3QuantTest: supertonic3
  }
}

function selectFunctionalEntries(modelsByTest, grep) {
  const tests = (grep || '')
    .split('|')
    .map((testName) => testName.trim())
    .filter(Boolean)
  if (tests.length === 0) {
    throw new Error('Functional shard grep is required')
  }
  const missing = tests.filter(
    (testName) => !Object.prototype.hasOwnProperty.call(modelsByTest, testName)
  )
  if (missing.length > 0) {
    throw new Error(`Missing functional mapping(s): ${missing.join(', ')}`)
  }
  const seen = new Set()
  return tests
    .flatMap((testName) => modelsByTest[testName])
    .filter((entry) => {
      if (seen.has(entry.targetName)) return false
      seen.add(entry.targetName)
      return true
    })
}

function buildTsv(entries) {
  return entries.map((entry) => `${entry.targetName}\t${entry.url}`).join('\n') + '\n'
}

// Host commands run before the Device Farm test: download each model on the
// host, then adb-push it to PRESTAGE_DIR. dirname handles the nested `lavasr/`
// targets (flat engine targets resolve to `.`), so both coexist on device.
function buildPrestageScript(listB64, variant) {
  return `set -euo pipefail
PRESTAGE_DIR=${PRESTAGE_DIR}
echo "${listB64}" | base64 -d > /tmp/prestage-list.tsv
adb shell mkdir -p "$PRESTAGE_DIR"
mkdir -p /tmp/prestage
while IFS=$(printf '\\t') read -r TARGET URL; do
  [ -z "$TARGET" ] && continue
  echo "[prestage] staging $TARGET (${variant})"
  mkdir -p "/tmp/prestage/$(dirname "$TARGET")"
  adb shell mkdir -p "$PRESTAGE_DIR/$(dirname "$TARGET")"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$TARGET" "$URL"
  adb push "/tmp/prestage/$TARGET" "$PRESTAGE_DIR/$TARGET"
  adb shell test -s "$PRESTAGE_DIR/$TARGET" || { echo "[prestage] FATAL: $TARGET missing after push"; exit 1; }
  rm -f "/tmp/prestage/$TARGET"
done < /tmp/prestage-list.tsv
echo "[prestage] device contents:"
adb shell ls -laR "$PRESTAGE_DIR" || true
echo "[prestage] done"`
}

function buildFunctionalSelectionCode() {
  return "const fs=require('fs');const input=process.env.FUNCTIONAL_MANIFEST_PATH||'/tmp/model-manifest.json';const output=process.env.FUNCTIONAL_LIST_PATH||'/tmp/prestage-list.tsv';const man=JSON.parse(fs.readFileSync(input,'utf8'));const g=process.env.GREP||'';if(!g)throw new Error('[prestage] functional shard grep is required');const tests=g.split('|').map(s=>s.trim()).filter(Boolean);const missing=tests.filter(t=>!Object.prototype.hasOwnProperty.call(man,t));if(missing.length)throw new Error('[prestage] missing functional mapping(s): '+missing.join(', '));const seen=new Set();const out=[];for(const t of tests){for(const m of man[t]){if(!seen.has(m.targetName)){seen.add(m.targetName);out.push(m.targetName+'\\t'+m.url)}}}fs.writeFileSync(output,out.join('\\n')+(out.length?'\\n':''));console.error('[prestage] '+out.length+' model(s) for '+tests.length+' test(s)')"
}

function buildFunctionalPrestageScript(manifestB64) {
  return `set -euo pipefail
PRESTAGE_DIR=${PRESTAGE_DIR}
echo "${manifestB64}" | base64 -d > /tmp/model-manifest.json
GREP=$(cat /tmp/qvacShardGrep.txt)
export GREP
echo "[prestage] shard grep: '$GREP'"
node -e "${buildFunctionalSelectionCode()}"
adb shell mkdir -p "$PRESTAGE_DIR"
mkdir -p /tmp/prestage
while IFS=$(printf '\\t') read -r TARGET URL; do
  [ -z "$TARGET" ] && continue
  echo "[prestage] staging $TARGET"
  mkdir -p "/tmp/prestage/$(dirname "$TARGET")"
  adb shell mkdir -p "$PRESTAGE_DIR/$(dirname "$TARGET")"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$TARGET" "$URL"
  adb push "/tmp/prestage/$TARGET" "$PRESTAGE_DIR/$TARGET"
  adb shell test -s "$PRESTAGE_DIR/$TARGET" || { echo "[prestage] FATAL: $TARGET missing after push"; exit 1; }
  rm -f "/tmp/prestage/$TARGET"
done < /tmp/prestage-list.tsv
echo "[prestage] device contents:"
adb shell ls -laR "$PRESTAGE_DIR" || true
echo "[prestage] done"`
}

function indentBlock(script) {
  return script
    .split('\n')
    .map((line) => '  ' + line)
    .join('\n')
}

function buildPrestageBlock(manifest, options) {
  const entries = selectEntries(manifest, options)
  const listB64 = Buffer.from(buildTsv(entries), 'utf8').toString('base64')
  return '|\n' + indentBlock(buildPrestageScript(listB64, options.variant)) + '\n'
}

function buildFunctionalPrestageBlock(manifest) {
  const manifestB64 = Buffer.from(JSON.stringify(functionalModelsByTest(manifest)), 'utf8').toString(
    'base64'
  )
  return '|\n' + indentBlock(buildFunctionalPrestageScript(manifestB64)) + '\n'
}

function readOptionsFromEnv(env) {
  return {
    variant: resolveVariant(env.TTS_GGML_MOBILE_BENCHMARK_VARIANT),
    engine: env.TTS_GGML_MOBILE_BENCHMARK_ENGINE || 'chatterbox',
    enhancer: env.TTS_GGML_MOBILE_BENCHMARK_ENHANCER || 'none',
    denoiser: env.TTS_GGML_MOBILE_BENCHMARK_DENOISER || 'none',
    quality: env.TTS_GGML_MOBILE_BENCHMARK_QUALITY !== 'false'
  }
}

function main() {
  const manifest = readManifest(MANIFEST_PATH)
  const block =
    process.env[FUNCTIONAL_MODE_ENV] === 'true'
      ? buildFunctionalPrestageBlock(manifest)
      : buildPrestageBlock(manifest, readOptionsFromEnv(process.env))
  process.stdout.write(block)
}

if (require.main === module) {
  main()
}

module.exports = {
  ALLOWED_VARIANTS,
  PRESTAGE_DIR,
  resolveVariant,
  engineEntries,
  cosyvoiceEntries,
  requestedLavasrKinds,
  lavasrEntries,
  qualityEntries,
  selectEntries,
  entriesByTarget,
  requiredEntriesByTarget,
  functionalModelsByTest,
  selectFunctionalEntries,
  buildTsv,
  buildPrestageScript,
  buildFunctionalSelectionCode,
  buildFunctionalPrestageScript,
  buildPrestageBlock,
  buildFunctionalPrestageBlock,
  readOptionsFromEnv
}
