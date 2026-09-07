'use strict'

const fs = require('fs')
const path = require('path')

const MANIFEST_PATH = path.resolve(__dirname, '../test/mobile/testAssets/model-manifest.json')
const PRESTAGE_DIR = '/data/local/tmp/qvac-tts-ggml/models'
// iOS stages into the app's Documents container (dev-signed get-task-allow app),
// exposed on-device as global.testDir. The resolver in test/utils/downloadModel.js
// already scans global.testDir/models (engine), .../models/lavasr (enhancer +
// denoiser) and .../models/whisper (quality), so pushing each manifest target
// under Documents/models/<target> is picked up with no on-device download and no
// resolver change.
//
// AFC parent-dir caveat: AfcService._push_internal only calls makedirs() on the
// *directory* branch of `apps push` — pushing a single file whose remote parent
// is missing raises AfcFileNotFoundError instead of creating it. The other iOS
// addons push flat into `Documents/<name>`, whose parent (Documents) always
// exists in a fresh container, so they never hit this. tts-ggml nests under
// `Documents/models/...`, which does not exist yet, so buildIosPrestageScript
// seeds that tree with one directory push before the per-file loop (see below).
const IOS_MODELS_ROOT = 'Documents/models'
const IOS_MODELS_PARENT = path.posix.dirname(IOS_MODELS_ROOT)
const IOS_MODELS_BASENAME = path.posix.basename(IOS_MODELS_ROOT)
const IOS_BUNDLE_ID = 'io.tether.test.qvac'
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
  parler: ['parler-mini-v1-q8_0.gguf'],
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
  const parlerModels = Array.isArray(manifest.parler) ? manifest.parler : []
  const parler = requiredEntriesByTarget(parlerModels, FUNCTIONAL_MODEL_TARGETS.parler, 'Parler')

  return {
    runAddonTest: chatterbox,
    runChatterboxKvCacheGpuTest: combineTargets(chatterbox, chatterboxMtl),
    runChatterboxMtlTest: chatterboxMtl,
    runChatterboxSpeedTest: chatterbox,
    runCosyvoice3LavasrTest: combineTargets(cosyvoice3, lavasrEnhancer, lavasrDenoiser),
    runCosyvoice3Test: cosyvoice3,
    runGpuSmokeTest: combineTargets(q4, cosyvoice3),
    runLavasrEnhancerTest: combineTargets(chatterbox, supertonic, lavasrEnhancer),
    runMultipleRunsTest: combineTargets(chatterbox, supertonic),
    runOutputSampleRateTest: supertonic,
    runParlerTest: parler,
    runSupertonicMtlTest: supertonicMtl,
    runSupertonicTest: supertonic,
    runSupertonic3QuantTest: supertonic3
  }
}

// The shard grep is a mocha --grep regex over runner NAMES (test-groups.json
// values, or the manual `tests` dispatch input). Match it against the known
// runner keys and stage the union of their models — so a partial pattern like
// `runChatterbox` correctly stages every runner it will run on device, not just
// an exact key. `modelsByTest` enumerates EVERY functional runner as a key,
// and a runner mapped to an empty model list would still match and stage
// nothing without erroring (every current runner stages at least one file —
// Parler was the last on-device downloader and is now staged). An empty grep is
// benign (no shard resolved). A NON-empty grep that fails to compile or matches
// zero runner keys is FATAL: the workflow_call lanes (weekend / on-merge /
// benchmarks) never run validate-devices, so a test-groups <-> model-map drift
// must fail closed here rather than silently ship an under-staged device. A
// manual dispatch filter is already validated by validate-devices, so this
// throw only fires on genuine drift.
function selectFunctionalEntries(modelsByTest, grep) {
  const pattern = (grep || '').trim()
  if (!pattern) {
    console.error('[prestage] WARN: no functional shard grep — staging nothing')
    return []
  }
  let re
  try {
    re = new RegExp(pattern)
  } catch (err) {
    throw new Error(`[prestage] invalid tests grep /${pattern}/: ${err.message}`)
  }
  const runners = Object.keys(modelsByTest).filter((testName) => re.test(testName))
  if (runners.length === 0) {
    throw new Error(`[prestage] tests grep /${pattern}/ matched no known runner`)
  }
  const seen = new Set()
  return runners
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

// iOS host script for the macOS Device Farm host. Mirrors the Android flow but
// stages into the app's Documents container via pymobiledevice3 instead of adb.
// Three host-environment quirks, all proven on Device Farm iOS:
//   1. The pre_test phase runs under sudo, so SUDO_UID/SUDO_GID are set and
//      pymobiledevice3 aborts trying to chown ~/.pymobiledevice3 (EPERM).
//      Unsetting them makes it skip the chown.
//   2. A failed `apps push` must fail the prestage. On the pinned
//      pymobiledevice3 (==10.3.1) an AFC error — including the
//      AfcFileNotFoundError raised when a remote parent is missing — is NOT
//      swallowed: it propagates as a traceback and a non-zero exit, so the guard
//      fails closed. The AFC failure-token regex is a version-proof backstop for
//      older CLIs that log the error but still exit 0 (it carries the two literal
//      handler prefixes "... not found during afc operation" / "failed to perform
//      afc operation"). This gives iOS the fail-closed guarantee Android gets
//      from `adb shell test -s`.
//   3. `apps push` (AfcService._push_internal) only makedirs() on the directory
//      branch; pushing a single file whose remote parent is missing raises
//      AfcFileNotFoundError instead of creating it, and Documents/models does
//      not exist in a fresh container. So before the per-file loop, seed the
//      whole tree by pushing an empty local scaffold directory (its subdirs
//      built from the selected targets' dirnames) — that push takes the
//      directory branch, which recursively makedirs every dir in it, so the
//      per-file pushes below always find their parent already there.
//
// Functional multi-spec mode (buildFunctionalPrestageScript below) is
// Android-only for now — iOS doesn't run the functional shard matrix yet, so
// buildIosPrestageScript only needs to cover the regular variant-based flow.
function buildIosPrestageScript(listB64, variant) {
  return `set -e
export PATH="$HOME/.local/bin:$PATH"
unset SUDO_UID SUDO_GID
BID=${IOS_BUNDLE_ID}
MODELS_ROOT=${IOS_MODELS_ROOT}
MODELS_PARENT=${IOS_MODELS_PARENT}
SCAFFOLD_DIR=/tmp/prestage-scaffold/${IOS_MODELS_BASENAME}
echo "[prestage] installing pymobiledevice3..."
python3 -m pip install --quiet --upgrade pymobiledevice3==10.3.1 || pip3 install --quiet --upgrade pymobiledevice3==10.3.1 || python3 -m pip install --quiet --upgrade --break-system-packages pymobiledevice3==10.3.1 || { echo "[prestage] FATAL: pymobiledevice3 install failed"; exit 1; }
pymobiledevice3 version >/dev/null 2>&1 || { echo "[prestage] FATAL: pymobiledevice3 not runnable"; exit 1; }
echo "${listB64}" | base64 -d > /tmp/prestage-list.tsv
rm -rf "$SCAFFOLD_DIR"
mkdir -p "$SCAFFOLD_DIR"
while IFS=$(printf '\\t') read -r TARGET URL; do
  [ -z "$TARGET" ] && continue
  SUBDIR="$(dirname "$TARGET")"
  [ "$SUBDIR" != "." ] && mkdir -p "$SCAFFOLD_DIR/$SUBDIR"
done < /tmp/prestage-list.tsv
echo "[prestage] seeding device dir tree at $MODELS_ROOT..."
if SEED_OUT=$(pymobiledevice3 apps push "$BID" "$SCAFFOLD_DIR" "$MODELS_PARENT" 2>&1); then SEED_RC=0; else SEED_RC=$?; fi
printf '%s\\n' "$SEED_OUT"
if [ "$SEED_RC" -ne 0 ] || printf '%s' "$SEED_OUT" | grep -qiE "traceback|afcexception|not found during afc operation|failed to perform afc operation|failed with status|perm_denied|object_not_found|not permitted"; then
  echo "[prestage] FATAL: seeding $MODELS_ROOT dir tree failed (rc=$SEED_RC; see AFC error above)"; exit 1
fi
echo "[prestage] seeded $MODELS_ROOT"
mkdir -p /tmp/prestage
while IFS=$(printf '\\t') read -r TARGET URL; do
  [ -z "$TARGET" ] && continue
  echo "[prestage] staging $TARGET (${variant})"
  mkdir -p "/tmp/prestage/$(dirname "$TARGET")"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$TARGET" "$URL"
  if PUSH_OUT=$(pymobiledevice3 apps push "$BID" "/tmp/prestage/$TARGET" "$MODELS_ROOT/$TARGET" 2>&1); then PUSH_RC=0; else PUSH_RC=$?; fi
  printf '%s\\n' "$PUSH_OUT"
  if [ "$PUSH_RC" -ne 0 ] || printf '%s' "$PUSH_OUT" | grep -qiE "traceback|afcexception|not found during afc operation|failed to perform afc operation|failed with status|perm_denied|object_not_found|not permitted"; then
    echo "[prestage] FATAL: push of $TARGET failed (rc=$PUSH_RC; see AFC error above)"; exit 1
  fi
  echo "[prestage] pushed $TARGET -> $MODELS_ROOT/$TARGET"
  rm -f "/tmp/prestage/$TARGET"
done < /tmp/prestage-list.tsv
echo "[prestage] done"`
}

// Device-side mirror of selectFunctionalEntries (serialized into the pre_test
// host block): regex-match the grep against runner NAMES and stage the union of
// their models. An empty grep is benign (no shard resolved). A non-empty grep
// that fails to compile or matches zero runner keys fails closed (throws) so a
// test-groups <-> model-map drift on the validate-devices-less workflow_call
// lanes cannot silently ship an under-staged device.
function buildFunctionalSelectionCode() {
  return "const fs=require('fs');const input=process.env.FUNCTIONAL_MANIFEST_PATH||'/tmp/model-manifest.json';const output=process.env.FUNCTIONAL_LIST_PATH||'/tmp/prestage-list.tsv';const man=JSON.parse(fs.readFileSync(input,'utf8'));const g=(process.env.GREP||'').trim();let re=null;if(!g){console.error('[prestage] WARN: no functional shard grep — staging nothing')}else{try{re=new RegExp(g)}catch(e){throw new Error('[prestage] invalid tests grep /'+g+'/: '+e.message)}}const runners=re?Object.keys(man).filter(k=>re.test(k)):[];if(re&&runners.length===0)throw new Error('[prestage] tests grep /'+g+'/ matched no known runner');const seen=new Set();const out=[];for(const t of runners){for(const m of man[t]){if(!seen.has(m.targetName)){seen.add(m.targetName);out.push(m.targetName+'\\t'+m.url)}}}fs.writeFileSync(output,out.join('\\n')+(out.length?'\\n':''));console.error('[prestage] '+out.length+' model(s) for '+runners.length+' test(s)')"
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

function buildPlatformScript(listB64, variant, platform) {
  const p = String(platform).toLowerCase()
  if (p === 'ios') return buildIosPrestageScript(listB64, variant)
  if (p === 'android') return buildPrestageScript(listB64, variant)
  throw new Error(`[prestage] unknown platform "${platform}" (expected 'android' or 'ios')`)
}

function buildPrestageBlock(manifest, options, platform = 'android') {
  const entries = selectEntries(manifest, options)
  const listB64 = Buffer.from(buildTsv(entries), 'utf8').toString('base64')
  return '|\n' + indentBlock(buildPlatformScript(listB64, options.variant, platform)) + '\n'
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
  const platform = process.argv[2] || 'android'
  const manifest = readManifest(MANIFEST_PATH)
  const block =
    process.env[FUNCTIONAL_MODE_ENV] === 'true'
      ? buildFunctionalPrestageBlock(manifest)
      : buildPrestageBlock(manifest, readOptionsFromEnv(process.env), platform)
  process.stdout.write(block)
}

if (require.main === module) {
  main()
}

module.exports = {
  ALLOWED_VARIANTS,
  PRESTAGE_DIR,
  IOS_MODELS_ROOT,
  IOS_MODELS_PARENT,
  IOS_MODELS_BASENAME,
  IOS_BUNDLE_ID,
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
  buildIosPrestageScript,
  buildPlatformScript,
  buildFunctionalSelectionCode,
  buildFunctionalPrestageScript,
  buildPrestageBlock,
  buildFunctionalPrestageBlock,
  readOptionsFromEnv
}
